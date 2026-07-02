import { BaseChatMemory } from '@langchain/community/memory/chat_memory';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { InputValues, MemoryVariables, OutputValues } from '@langchain/core/memory';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { logWrapper, getConnectionHintNoticeField } from '@n8n/ai-utilities';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type ILoadOptionsFunctions,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

interface EngramConfig {
	apiKey: string;
	baseUrl: string;
	// Global, stable identity for the person these memories belong to. Sent to
	// Engram as the `user_id` scope when set. Left `undefined` for project-scoped
	// Engram projects that don't scope by user. Configured explicitly on the node,
	// not derived from the n8n session.
	userId?: string;
	// Resolved scope properties (name -> value) as configured in the Engram
	// project (e.g. `conversation_id`, `session_id`, `thread_id`). Split because
	// store and search treat them differently:
	// - storeScopeProperties: ALWAYS sent on store — Engram rejects a store that
	//   omits a topic's required scope property.
	// - searchScopeProperties: sent on search only for the properties the user
	//   wants to filter retrieval by. Omitting one broadens recall across every
	//   value (e.g. store per conversation_id but still recall cross-conversation).
	// Values come from static/expression inputs or the resolved n8n session id.
	storeScopeProperties?: Record<string, string>;
	searchScopeProperties?: Record<string, string>;
	groupId?: string;
	searchLimit: number;
	retrievalType: 'vector' | 'bm25' | 'hybrid';
	storeProperties?: Record<string, string>;
	searchProperties?: Record<string, string>;
	searchTopics?: string[];
	root?: string;
	waitForCompletion?: boolean;
	// Default 30000ms matches the Engram Python SDK (httpx timeout=30.0). Node's
	// undici default connect timeout is only 10s, which is what was triggering
	// UND_ERR_CONNECT_TIMEOUT on cold connections from n8n.
	timeoutMs: number;
	// Captured at supplyData time so loadMemoryVariables({}) can still drive a
	// semantic search — the n8n AI Agent calls loadMemoryVariables with no
	// `values`, so we can't read the current input from there.
	currentInput?: string;
	// Optional n8n execution logger so transport failures surface in the node's
	// execution log panel, not just stdout. Wired from supplyData via this.logger.
	logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

interface EngramMemoryRecord {
	id?: string;
	content?: string;
	topic?: string;
	group?: string;
	created_at?: string;
}

interface EngramSearchResponse {
	memories?: EngramMemoryRecord[];
	total?: number;
}

// Shape of GET /v1/groups (Engram's GroupList schema). Drives the Group, Search
// Topics and Scope Properties dropdowns — and the runtime requirement checks —
// so users configure from what their Engram project actually defines instead of
// typing free-text that must match exactly.
interface EngramTopicScoping {
	// When true, memories in this topic are partitioned by `user_id`, so the
	// request must carry a User ID.
	user_scoped?: boolean;
	// Property names (e.g. `conversation_id`, `session_id`) that must be present
	// under `properties` on every store/search touching this topic.
	scope_properties?: string[];
}

interface EngramTopic {
	topic_name?: string;
	description?: string;
	scoping?: EngramTopicScoping;
}

interface EngramGroup {
	group_id?: string;
	name?: string;
	topics?: EngramTopic[];
}

interface EngramGroupList {
	groups?: EngramGroup[];
}

// A context that can authenticate an HTTP request against the Engram credential.
// Both loadOptions (config UI) and supplyData (execution) provide these, so the
// same fetch helper serves the dropdowns and the runtime requirement checks.
type EngramRequestContext = ILoadOptionsFunctions | ISupplyDataFunctions;

// Fetch the project's groups (with their topics/scoping). Reuses the
// credential's Bearer auth via httpRequestWithAuthentication so we don't
// re-implement auth here, and normalises the base URL the same way supplyData
// does.
async function fetchGroups(ctx: EngramRequestContext): Promise<EngramGroup[]> {
	const credentials = await ctx.getCredentials<{ baseUrl?: string }>('weaviateEngramApi');
	const baseUrl = (credentials.baseUrl ?? 'https://api.engram.weaviate.io').replace(/\/+$/, '');
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'weaviateEngramApi', {
		method: 'GET',
		url: `${baseUrl}/v1/groups`,
		json: true,
	})) as EngramGroupList | undefined;
	return response?.groups ?? [];
}

// An empty/unset Group falls back to Engram's built-in "default" group, so
// requirement discovery and the scope-property dropdown resolve against it too.
const DEFAULT_GROUP_NAME = 'default';

function resolveGroupName(groupId?: string): string {
	return groupId && groupId.length > 0 ? groupId : DEFAULT_GROUP_NAME;
}

// Read the top-level `groupId` from a loadOptions context. The scope-property
// and topics dropdowns live inside collections, and reading a sibling top-level
// param from a nested field is only reliable via getNodeParameter (as other
// nodes with nested loadOptions do). Falls back to getCurrentNodeParameter and
// then undefined so a read failure never blanks the dropdown.
function readSelectedGroup(ctx: ILoadOptionsFunctions): string | undefined {
	try {
		const value = ctx.getNodeParameter('groupId', 0) as string | undefined;
		if (value) return value;
	} catch {
		// Fall through to getCurrentNodeParameter.
	}
	try {
		return ctx.getCurrentNodeParameter('groupId') as string | undefined;
	} catch {
		return undefined;
	}
}

interface GroupRequirements {
	// True when any topic in the group is user-scoped — the request must send a
	// User ID.
	requiresUserId: boolean;
	// Union of every topic's `scope_properties` — each must be present under
	// `properties`.
	requiredScopeProperties: string[];
}

// Derive what a group requires by unioning the scoping across its topics. Store
// requests can land in any topic (Engram routes by extraction), so the union —
// not a single topic — is the safe requirement set.
function deriveGroupRequirements(groups: EngramGroup[], groupName: string): GroupRequirements {
	const group = groups.find((g) => g.name === groupName);
	const topics = group?.topics ?? [];
	const requiredScopeProperties = new Set<string>();
	let requiresUserId = false;
	for (const topic of topics) {
		if (topic.scoping?.user_scoped) requiresUserId = true;
		for (const property of topic.scoping?.scope_properties ?? []) {
			if (typeof property === 'string' && property.length > 0) {
				requiredScopeProperties.add(property);
			}
		}
	}
	return { requiresUserId, requiredScopeProperties: [...requiredScopeProperties] };
}

// Resolve the chat session ID the way n8n's memory nodes do for the "Connected
// Chat Trigger" option: read `$json.sessionId`, falling back to the connected
// Chat Trigger's output. Unlike the shared getSessionId() we do NOT append the
// per-node scoping suffix — Engram scope properties (conversation_id, etc.) need
// the raw session value, not a memory-bucket key.
function resolveChatSessionId(ctx: ISupplyDataFunctions, itemIndex: number): string | undefined {
	let sessionId = ctx.evaluateExpression('{{ $json.sessionId }}', itemIndex) as string | undefined;
	if (!sessionId) {
		try {
			const chatTrigger = ctx.getChatTrigger();
			if (chatTrigger) {
				sessionId = ctx.evaluateExpression(
					`{{ $('${chatTrigger.name}').first().json.sessionId }}`,
					itemIndex,
				) as string | undefined;
			}
		} catch {
			// No reachable Chat Trigger — leave sessionId undefined.
		}
	}
	return sessionId || undefined;
}

function messageRole(message: BaseMessage): 'user' | 'assistant' | 'system' {
	const type = message.getType();
	if (type === 'human') return 'user';
	if (type === 'ai') return 'assistant';
	return 'system';
}

function stringifyContent(content: BaseMessage['content']): string {
	if (typeof content === 'string') return content;
	return JSON.stringify(content);
}

async function engramFetch(
	url: string,
	apiKey: string,
	body: unknown,
	timeoutMs: number,
	method: 'POST' | 'GET' = 'POST',
): Promise<unknown> {
	// One-shot retry on transient connect timeouts. undici has a 10s default
	// connect timeout and sometimes the first connection to a new host fails
	// (cold pool, IPv6 fallback, etc.) but a second attempt succeeds.
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await fetch(url, {
				method,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: method === 'GET' ? undefined : JSON.stringify(body),
				// Match the Engram Python SDK default (httpx timeout=30.0) — node's
				// undici has a 10s connect timeout by default which is too short
				// for some networks.
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				// Engram error responses follow application/problem+json:
				// { status, title, detail }. Extract `detail` if present so the
				// thrown Error carries a human-readable summary instead of the
				// raw JSON blob, while still attaching the full body for logs.
				let detail = text;
				let parsed: unknown;
				if (text) {
					try {
						const obj = JSON.parse(text) as { detail?: unknown; title?: unknown };
						parsed = obj;
						if (typeof obj.detail === 'string' && obj.detail.length > 0) {
							detail = obj.detail;
						} else if (typeof obj.title === 'string' && obj.title.length > 0) {
							detail = obj.title;
						}
					} catch {
						// Body isn't JSON — fall back to raw text.
					}
				}
				// This helper runs inside langchain memory classes, not an n8n
				// execute block, so NodeOperationError isn't usable here.
				const apiError = new Error(
					`Engram API error ${response.status}: ${detail || response.statusText}`,
				) as Error & { status?: number; body?: unknown };
				apiError.status = response.status;
				apiError.body = parsed ?? text;
				throw apiError;
			}
			if (response.status === 204) return undefined;
			const contentType = response.headers.get('content-type') ?? '';
			if (contentType.includes('application/json')) {
				return (await response.json()) as unknown;
			}
			return undefined;
		} catch (error) {
			lastError = error;
			const code =
				(error as { code?: string; cause?: { code?: string } }).code ??
				(error as { cause?: { code?: string } }).cause?.code;
			// Only retry connect-level transient failures, never HTTP errors.
			const retriable =
				code === 'UND_ERR_CONNECT_TIMEOUT' ||
				code === 'ECONNRESET' ||
				code === 'ETIMEDOUT' ||
				code === 'EAI_AGAIN';
			if (!retriable || attempt === 1) throw error;
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	throw lastError;
}

interface CreateMemoryResponse {
	run_id?: string;
	status?: string;
}

interface RunStatusResponse {
	run_id?: string;
	status?: string;
	error?: string;
}

// Poll an async Engram pipeline run until it reaches a terminal state. Used by
// the "Wait for Completion" option so downstream nodes can immediately search
// for what was just stored. Capped by the same timeout the request uses.
async function pollRun(
	baseUrl: string,
	apiKey: string,
	runId: string,
	timeoutMs: number,
): Promise<RunStatusResponse | undefined> {
	const url = `${baseUrl}/v1/runs/${runId}`;
	const deadline = Date.now() + timeoutMs;
	const intervalMs = 250;
	while (Date.now() < deadline) {
		const response = (await engramFetch(url, apiKey, undefined, timeoutMs, 'GET')) as
			| RunStatusResponse
			| undefined;
		const status = response?.status;
		if (status === 'completed' || status === 'failed' || status === 'in_buffer') {
			return response;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return undefined;
}

// Flatten a fixedCollection value (`{ property: [{key,value},...] }`) into a
// plain Record<string,string>. Returns `undefined` for empty inputs so callers
// can skip the field entirely in API payloads.
function fixedCollectionToMap(
	value: { property?: Array<{ key?: string; value?: string }> } | undefined,
): Record<string, string> | undefined {
	const entries = value?.property;
	if (!entries || entries.length === 0) return undefined;
	const map: Record<string, string> = {};
	for (const entry of entries) {
		if (typeof entry.key === 'string' && entry.key.length > 0) {
			map[entry.key] = entry.value ?? '';
		}
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

interface EngramLogger {
	warn: (message: string, meta?: Record<string, unknown>) => void;
}

function logFetchFailure(
	scope: 'search' | 'add' | 'run',
	url: string,
	error: unknown,
	extra: Record<string, unknown>,
	logger?: EngramLogger,
): void {
	const e = error as Error & {
		cause?: unknown;
		code?: string;
		status?: number;
		body?: unknown;
	};
	const cause = e.cause as
		| { code?: string; errno?: string; syscall?: string; message?: string; hostname?: string }
		| undefined;
	const details = {
		scope,
		url,
		message: e.message,
		status: e.status,
		code: e.code ?? cause?.code,
		errno: cause?.errno,
		syscall: cause?.syscall,
		hostname: cause?.hostname,
		causeMessage: cause?.message,
		...extra,
	};

	const headline = `[WeaviateEngram] ${scope} failed: ${e.message}`;
	if (logger) {
		// Surface through the n8n execution logger so the error shows up in the
		// node's execution log panel, not just stdout. Pass the full structured
		// detail as the meta object so users can inspect group/root/etc. in the
		// UI when expanding the log entry.
		logger.warn(headline, details);
	} else {
		console.warn(`[WeaviateEngram] ${scope} failed:`, JSON.stringify(details));
		if (e.stack) {
			console.warn(`[WeaviateEngram] ${scope} stack:`, e.stack.split('\n').slice(0, 6).join('\n'));
		}
	}
}

export class EngramChatMessageHistory extends BaseListChatMessageHistory {
	lc_namespace = ['n8n', 'memory', 'weaviate_engram'];

	private buffer: BaseMessage[] = [];

	constructor(private readonly config: EngramConfig) {
		super();
	}

	async getMessages(): Promise<BaseMessage[]> {
		return await Promise.resolve(this.buffer);
	}

	async addMessage(message: BaseMessage): Promise<void> {
		this.buffer.push(message);
		await this.postMemories([message]);
	}

	override async addMessages(messages: BaseMessage[]): Promise<void> {
		if (messages.length === 0) return;
		this.buffer.push.apply(this.buffer, messages);
		await this.postMemories(messages);
	}

	private async postMemories(messages: BaseMessage[]): Promise<void> {
		const payload: Record<string, unknown> = {
			input: {
				conversation: {
					messages: messages.map((m) => ({
						role: messageRole(m),
						content: stringifyContent(m.content),
					})),
				},
			},
		};
		// Only scope by user when a User ID is configured. Project-scoped Engram
		// projects don't require (or accept) a user_id.
		if (this.config.userId) payload.user_id = this.config.userId;
		if (this.config.groupId) payload.group = this.config.groupId;
		// Send the group's required scope properties (name -> value as configured
		// in the Engram project) merged with any user-defined tags. Omit the field
		// entirely when neither is present.
		const properties: Record<string, string> = {
			...(this.config.storeProperties ?? {}),
			...(this.config.storeScopeProperties ?? {}),
		};
		if (Object.keys(properties).length > 0) {
			payload.properties = properties;
		}
		if (this.config.root) payload.root = this.config.root;
		try {
			const response = (await engramFetch(
				`${this.config.baseUrl}/v1/memories`,
				this.config.apiKey,
				payload,
				this.config.timeoutMs,
			)) as CreateMemoryResponse | undefined;

			if (this.config.waitForCompletion && response?.run_id) {
				try {
					await pollRun(
						this.config.baseUrl,
						this.config.apiKey,
						response.run_id,
						this.config.timeoutMs,
					);
				} catch (error) {
					logFetchFailure(
						'run',
						`${this.config.baseUrl}/v1/runs/${response.run_id}`,
						error,
						{
							runId: response.run_id,
							timeoutMs: this.config.timeoutMs,
						},
						this.config.logger,
					);
				}
			}
		} catch (error) {
			logFetchFailure(
				'add',
				`${this.config.baseUrl}/v1/memories`,
				error,
				{
					userIdLength: this.config.userId?.length,
					scopeProperties: this.config.storeScopeProperties,
					group: this.config.groupId,
					root: this.config.root,
					storeProperties: this.config.storeProperties,
					messageCount: messages.length,
					timeoutMs: this.config.timeoutMs,
				},
				this.config.logger,
			);
			throw error;
		}
	}

	async clear(): Promise<void> {
		this.buffer = [];
		return await Promise.resolve();
	}
}

export class EngramMemory extends BaseChatMemory {
	lc_namespace = ['n8n', 'memory', 'weaviate_engram'];

	memoryKey: string;

	private readonly config: EngramConfig;

	constructor(fields: {
		config: EngramConfig;
		memoryKey?: string;
		returnMessages?: boolean;
		inputKey?: string;
		outputKey?: string;
	}) {
		super({
			chatHistory: new EngramChatMessageHistory(fields.config),
			returnMessages: fields.returnMessages ?? true,
			inputKey: fields.inputKey ?? 'input',
			outputKey: fields.outputKey ?? 'output',
		});
		this.config = fields.config;
		this.memoryKey = fields.memoryKey ?? 'chat_history';
	}

	get memoryKeys(): string[] {
		return [this.memoryKey];
	}

	async loadMemoryVariables(values: InputValues): Promise<MemoryVariables> {
		// n8n's AI Agent invokes loadMemoryVariables({}) with no input, so fall
		// back to the input captured at supplyData time. As a secondary fallback
		// (multi-turn loops within a single agent execution), use the most
		// recent HumanMessage from the in-process buffer.
		const sessionMessages = await this.chatHistory.getMessages();
		const fromValues = this.inputKey ? (values[this.inputKey] as string | undefined) : undefined;
		const fromBuffer = [...sessionMessages].reverse().find((m) => messageRole(m) === 'user');
		const query =
			fromValues ??
			this.config.currentInput ??
			(fromBuffer ? stringifyContent(fromBuffer.content) : undefined);

		const longTermMessages = query ? await this.searchEngram(query) : [];
		const combined = [...longTermMessages, ...sessionMessages];

		if (this.returnMessages) {
			return { [this.memoryKey]: combined };
		}
		return {
			[this.memoryKey]: combined
				.map((m) => `${messageRole(m)}: ${stringifyContent(m.content)}`)
				.join('\n'),
		};
	}

	override async saveContext(inputValues: InputValues, outputValues: OutputValues): Promise<void> {
		const inputKey = this.inputKey ?? 'input';
		const outputKey = this.outputKey ?? 'output';
		const messages: BaseMessage[] = [];
		const input: unknown = inputValues[inputKey];
		const output: unknown = outputValues[outputKey];
		if (typeof input === 'string' && input.length > 0) messages.push(new HumanMessage(input));
		if (typeof output === 'string' && output.length > 0) messages.push(new AIMessage(output));
		if (messages.length > 0) {
			await this.chatHistory.addMessages(messages);
		}
	}

	private async searchEngram(query: string): Promise<BaseMessage[]> {
		const payload: Record<string, unknown> = {
			query,
			retrieval_config: {
				retrieval_type: this.config.retrievalType,
				limit: this.config.searchLimit,
			},
		};
		// Only scope by user when a User ID is configured (see postMemories).
		if (this.config.userId) payload.user_id = this.config.userId;
		if (this.config.groupId) payload.group = this.config.groupId;
		if (this.config.searchTopics && this.config.searchTopics.length > 0) {
			payload.topics = this.config.searchTopics;
		}
		// Only the scope properties the user opted to filter search by are sent
		// here — each narrows retrieval to memories matching that value. Ones left
		// out broaden recall across every value of that property (e.g. store per
		// conversation_id but recall cross-conversation). Merged with any
		// user-defined search filters.
		const searchProperties: Record<string, string> = {
			...(this.config.searchProperties ?? {}),
			...(this.config.searchScopeProperties ?? {}),
		};
		if (Object.keys(searchProperties).length > 0) {
			payload.properties = searchProperties;
		}

		try {
			const response = (await engramFetch(
				`${this.config.baseUrl}/v1/memories/search`,
				this.config.apiKey,
				payload,
				this.config.timeoutMs,
			)) as EngramSearchResponse | undefined;

			const items = response?.memories ?? [];
			return items
				.map((item) => item.content)
				.filter((c): c is string => typeof c === 'string' && c.length > 0)
				.map((content) => new SystemMessage(`Relevant memory: ${content}`));
		} catch (error) {
			// Engram returns 422 "user X not found" when a user_id has never had
			// a memory stored for it. For chat memory this is the expected cold
			// start: the first search runs before the first saveContext, so the
			// user doesn't exist yet — saveContext on the same turn will create
			// it. Treat this as "no memories yet" and silently return [].
			if (isFirstRunUserNotFound(error)) {
				return [];
			}
			// Don't take the agent down — but make the failure visible in n8n's
			// execution log so misconfigured user_id / group / retrieval_type
			// issues are diagnosable instead of silently degrading to no memory.
			logFetchFailure(
				'search',
				`${this.config.baseUrl}/v1/memories/search`,
				error,
				{
					userIdLength: this.config.userId?.length,
					scopeProperties: this.config.searchScopeProperties,
					group: this.config.groupId,
					retrievalType: this.config.retrievalType,
					searchTopics: this.config.searchTopics,
					searchProperties: this.config.searchProperties,
					queryLength: query.length,
					timeoutMs: this.config.timeoutMs,
				},
				this.config.logger,
			);
			return [];
		}
	}
}

// True for Engram's "user not found" 422 — the expected cold-start error on
// the very first search against a new user_id (the user gets created by the
// subsequent POST /v1/memories). Matches both shapes: the structured body's
// `detail` field, or the raw error message when body parsing failed.
function isFirstRunUserNotFound(error: unknown): boolean {
	const e = error as { status?: number; body?: unknown; message?: string };
	if (e.status !== 422) return false;
	let bodyDetail = '';
	if (typeof e.body === 'object' && e.body !== null && 'detail' in e.body) {
		const raw = (e.body as { detail: unknown }).detail;
		if (typeof raw === 'string') bodyDetail = raw;
	}
	const text = bodyDetail !== '' ? bodyDetail : (e.message ?? '');
	return /user\s+"?[^"]+"?\s+not found/i.test(text);
}

export class MemoryWeaviateEngramChat implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Weaviate Engram',
		name: 'memoryWeaviateEngramChat',
		icon: 'file:weaviate.svg',
		group: ['transform'],
		version: 1,
		description: 'Use Weaviate Engram as long-term semantic memory for an AI Agent',
		defaults: {
			name: 'Weaviate Engram',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
				Memory: ['Other memories'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.weaviate.io/engram',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiMemory],
		outputNames: ['Memory'],
		credentials: [
			{
				name: 'weaviateEngramApi',
				required: true,
			},
		],
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiAgent]),
			{
				displayName:
					'Set <b>User ID</b> if your Engram project has user-scoped topics. Add a <b>Scope Property</b> row for each scope your project defines (e.g. <code>conversation_id</code>, <code>session_id</code>), mapping it to a value or the n8n session. Requirements are read from your project via the group you select. <a href="https://docs.weaviate.io/engram" target="_blank">Learn more</a>.',
				name: 'scopingNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				placeholder: 'e.g. alice@example.com',
				description:
					"The global, stable identifier for the person these memories belong to, sent to Engram as the <code>user_id</code> scope. Required when the selected group has user-scoped topics. Set a static value or an expression (e.g. an authenticated user from a previous node). Takes precedence over a <code>user_id</code> row in Scope Properties. Leave empty for project-scoped Engram projects that don't scope by user.",
			},
			{
				displayName: 'Group Name or ID',
				name: 'groupId',
				type: 'options',
				default: '',
				typeOptions: {
					loadOptionsMethod: 'getGroups',
				},
				hint: 'Loaded from your Engram project. Leave empty to fall back to the "default" group. Engram does not auto-create groups, so only existing groups are listed.',
				description:
					'Optional conversation- or project-level scope (sent as Engram\'s "group" field), used to filter both adds and searches. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Scope Properties',
				name: 'scopeProperties',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Scope Property',
				description:
					'Values for the scope values your Engram project requires (read from the selected group), including <code>user_id</code> when the group is user-scoped. Scope properties are sent under <code>properties</code>; <code>user_id</code> is sent as the top-level user scope. Map a value to the n8n session to group memories by conversation.',
				options: [
					{
						name: 'property',
						displayName: 'Property',
						values: [
							{
								displayName: 'Property Name or ID',
								name: 'name',
								type: 'options',
								default: '',
								typeOptions: {
									loadOptionsMethod: 'getScopeProperties',
									loadOptionsDependsOn: ['groupId'],
								},
								description:
									'Scope property required by the selected group. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
							},
							{
								displayName: 'Value Source',
								name: 'source',
								type: 'options',
								options: [
									{ name: 'Value', value: 'value' },
									{ name: 'N8n Session ID', value: 'session' },
								],
								default: 'value',
								description:
									'Where the property value comes from: a static value/expression, or the session ID from a connected Chat Trigger',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								displayOptions: { show: { source: ['value'] } },
								description: 'The value to send for this scope property',
							},
							{
								// Cosmetic, disabled field mirroring the standard "Connected
								// Chat Trigger" session control — it shows the user what will
								// be sent. The value is resolved at runtime from the Chat
								// Trigger, not read from this field.
								displayName: 'Value (From Chat Trigger)',
								name: 'sessionPreview',
								type: 'string',
								default: '={{ $json.sessionId }}',
								disabledOptions: { show: { source: ['session'] } },
								displayOptions: { show: { source: ['session'] } },
								description:
									"Uses the session ID from a directly connected Chat Trigger (its 'sessionId' output)",
							},
							{
								displayName: 'Filter Search by This Value',
								name: 'filterSearch',
								type: 'boolean',
								default: true,
								description:
									'Whether retrieval is narrowed to memories matching this value. The value is always sent when storing; turn this off to still store it but recall across every value of this property (e.g. store per conversation but search across all conversations).',
							},
						],
					},
				],
			},
			{
				displayName: 'Retrieval Type',
				name: 'retrievalType',
				type: 'options',
				options: [
					{ name: 'Hybrid', value: 'hybrid' },
					{ name: 'Vector', value: 'vector' },
					{ name: 'BM25', value: 'bm25' },
				],
				default: 'hybrid',
				description:
					'How Engram searches long-term memory: vector (semantic), BM25 (keyword), or hybrid (both)',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Search Limit',
						name: 'searchLimit',
						type: 'number',
						default: 10,
						description: 'Maximum number of long-term memories to retrieve from Engram each turn',
					},
					{
						displayName: 'Request Timeout (Ms)',
						name: 'timeoutMs',
						type: 'number',
						default: 30000,
						description:
							'Maximum time to wait for an Engram request before aborting. Matches the Engram Python SDK default (30s). Increase if you see UND_ERR_CONNECT_TIMEOUT in the n8n log.',
					},
					{
						displayName: 'Search Topic Names or IDs',
						name: 'searchTopics',
						type: 'multiOptions',
						typeOptions: {
							loadOptionsMethod: 'getTopics',
							loadOptionsDependsOn: ['groupId'],
						},
						default: [],
						description:
							'Restrict search to these Engram topics. Loaded from the selected group (or all groups when none is selected). Leave empty to search across all topics. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Search Properties Filter',
						name: 'searchProperties',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						default: {},
						placeholder: 'Add Property',
						description:
							'Filter retrieved memories by scope properties (key/value match against memory metadata)',
						options: [
							{
								name: 'property',
								displayName: 'Property',
								values: [
									{
										displayName: 'Key',
										name: 'key',
										type: 'string',
										default: '',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string',
										default: '',
									},
								],
							},
						],
					},
					{
						displayName: 'Memory Tags',
						name: 'storeProperties',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						default: {},
						placeholder: 'Add Property',
						description:
							'Scope properties to attach to each new memory (e.g. environment, channel)',
						options: [
							{
								name: 'property',
								displayName: 'Property',
								values: [
									{
										displayName: 'Key',
										name: 'key',
										type: 'string',
										default: '',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string',
										default: '',
									},
								],
							},
						],
					},
					{
						displayName: 'Pipeline Root',
						name: 'root',
						type: 'string',
						default: '',
						description:
							'Override the Engram pipeline entry-point. Leave empty unless instructed by Engram support.',
					},
					{
						displayName: 'Wait for Completion',
						name: 'waitForCompletion',
						type: 'boolean',
						default: false,
						description:
							'Whether to poll /v1/runs/{run_id} until Engram commits the memory before continuing. Adds latency but ensures downstream searches see the new memory immediately.',
					},
					{
						displayName: 'Advanced',
						name: 'advanced',
						type: 'collection',
						placeholder: 'Add Advanced Option',
						default: {},
						description:
							'LangChain-level overrides that only matter when a downstream chain reads memory variables directly. The n8n AI Agent hardcodes "chat_history" / "input" / "output" and ignores these.',
						options: [
							{
								displayName: 'Memory Key',
								name: 'memoryKey',
								type: 'string',
								default: 'chat_history',
								description:
									'Variable name under which retrieved memories are returned. The n8n AI Agent always reads "chat_history" — change only if a custom chain (e.g. a Code node calling loadMemoryVariables) expects a different key.',
							},
							{
								displayName: 'Input Key',
								name: 'inputKey',
								type: 'string',
								default: 'input',
								description:
									'Key read from inputValues when saving a turn. The n8n AI Agent always passes "input" — change only for custom chains that use a different key.',
							},
							{
								displayName: 'Output Key',
								name: 'outputKey',
								type: 'string',
								default: 'output',
								description:
									'Key read from outputValues when saving a turn. The n8n AI Agent always passes "output" — change only for custom chains that use a different key.',
							},
						],
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			// Populate the Group dropdown from GET /v1/groups so users pick an
			// existing group instead of typing a name that must match exactly.
			async getGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const groups = await fetchGroups(this);
				return groups
					.map((group) => group.name)
					.filter((name): name is string => typeof name === 'string' && name.length > 0)
					.sort((a, b) => a.localeCompare(b))
					.map((name) => ({ name, value: name }));
			},
			// Populate the Search Topics dropdown from the same groups payload,
			// scoped to the selected group when one is chosen (otherwise every
			// group's topics). De-duplicated since topic names can repeat across
			// groups, and annotated with each topic's description as a tooltip.
			async getTopics(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const groups = await fetchGroups(this);
				const selectedGroup = readSelectedGroup(this);
				const matched =
					selectedGroup && selectedGroup.length > 0
						? groups.filter((group) => group.name === selectedGroup)
						: [];
				const relevant = matched.length > 0 ? matched : groups;

				const seen = new Set<string>();
				const options: INodePropertyOptions[] = [];
				for (const group of relevant) {
					for (const topic of group.topics ?? []) {
						const name = topic.topic_name;
						if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
							seen.add(name);
							options.push({
								name,
								value: name,
								description: topic.description,
							});
						}
					}
				}
				return options.sort((a, b) => a.name.localeCompare(b.name));
			},
			// Populate the Scope Property dropdown with the scope properties defined
			// in the Engram project. Scoped to the selected group when one is
			// chosen and matches; otherwise the union across every group, so the
			// dropdown is never needlessly empty (e.g. before a group is picked, or
			// when the sibling group value can't be read from this nested field).
			async getScopeProperties(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const groups = await fetchGroups(this);
				const selectedGroup = readSelectedGroup(this);
				const matched =
					selectedGroup && selectedGroup.length > 0
						? groups.filter((group) => group.name === selectedGroup)
						: [];
				const relevant = matched.length > 0 ? matched : groups;

				const seen = new Set<string>();
				for (const group of relevant) {
					for (const topic of group.topics ?? []) {
						// `user_id` is a scope value too — when any topic is user-scoped
						// the request must carry it, so it belongs in this dropdown
						// alongside the per-topic `scope_properties`.
						if (topic.scoping?.user_scoped) seen.add('user_id');
						for (const property of topic.scoping?.scope_properties ?? []) {
							if (typeof property === 'string' && property.length > 0) seen.add(property);
						}
					}
				}
				return [...seen].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, value: name }));
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials<{
			apiKey: string;
			baseUrl: string;
		}>('weaviateEngramApi');

		// User ID is optional: Engram projects can be project-scoped (no user_id),
		// user-scoped (user_id), or conversation-scoped (user_id + scope
		// properties like conversation_id / session_id). It can be set via the
		// dedicated field below or mapped as a `user_id` row in Scope Properties.
		const dedicatedUserId = (this.getNodeParameter('userId', itemIndex, '') as string).trim();

		const groupId = (this.getNodeParameter('groupId', itemIndex, '') as string).trim();

		// Resolve the Scope Properties mapper into two name -> value maps. Each row
		// draws its value from a static value/expression or the resolved n8n
		// session. Values are ALWAYS sent when storing; on search only the rows
		// the user opted to filter by are sent, so recall can stay broad for the
		// others. The session is only resolved (and required) when a row asks for
		// it, so project-scoped setups need no session at all.
		const scopeRows =
			(
				this.getNodeParameter('scopeProperties', itemIndex, {}) as {
					property?: Array<{
						name?: string;
						source?: 'value' | 'session';
						value?: string;
						filterSearch?: boolean;
					}>;
				}
			).property ?? [];

		let sessionId: string | undefined;
		if (scopeRows.some((row) => row.source === 'session')) {
			sessionId = resolveChatSessionId(this, itemIndex);
			if (!sessionId) {
				throw new NodeOperationError(
					this.getNode(),
					'No session ID found for a Scope Property mapped to the n8n Session ID',
					{
						description:
							"Expected a 'sessionId' field from a directly connected Chat Trigger. Connect a Chat Trigger, or switch that Scope Property's Value Source to 'Value'.",
						itemIndex,
					},
				);
			}
		}

		const storeScopeProperties: Record<string, string> = {};
		const searchScopeProperties: Record<string, string> = {};
		let mappedUserId: string | undefined;
		for (const row of scopeRows) {
			const name = row.name?.trim();
			if (!name) continue;
			const value = row.source === 'session' ? sessionId : row.value;
			if (typeof value !== 'string' || value.length === 0) continue;
			// `user_id` is a top-level Engram scope, not a `properties` entry — route
			// it to user_id (always applied to both store and search) rather than
			// into the scope-property maps.
			if (name === 'user_id') {
				mappedUserId = value;
				continue;
			}
			storeScopeProperties[name] = value;
			// Default to filtering search by the value (filterSearch defaults to
			// true in the UI); only skip it when the user explicitly turned it off.
			if (row.filterSearch !== false) {
				searchScopeProperties[name] = value;
			}
		}

		// The dedicated User ID field wins when set; otherwise fall back to a
		// `user_id` row mapped in Scope Properties.
		const userId = dedicatedUserId || mappedUserId;

		const retrievalType = this.getNodeParameter('retrievalType', itemIndex, 'hybrid') as
			| 'hybrid'
			| 'vector'
			| 'bm25';
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			searchLimit?: number;
			timeoutMs?: number;
			searchTopics?: string[];
			searchProperties?: { property?: Array<{ key?: string; value?: string }> };
			storeProperties?: { property?: Array<{ key?: string; value?: string }> };
			root?: string;
			waitForCompletion?: boolean;
			advanced?: {
				memoryKey?: string;
				inputKey?: string;
				outputKey?: string;
			};
		};

		const baseUrl = (credentials.baseUrl ?? 'https://api.engram.weaviate.io').replace(/\/+$/, '');

		// n8n's AI Agent calls loadMemoryVariables({}) with no input, so we
		// capture the current chat input here (where we still have execution
		// context) and use it as the Engram search query later. Try the common
		// keys produced by the Chat Trigger / agent prompt nodes.
		const currentInput = ['chatInput', 'input', 'text', 'prompt']
			.map((key) => {
				try {
					return this.evaluateExpression(`{{ $json.${key} }}`, itemIndex) as string | undefined;
				} catch {
					return undefined;
				}
			})
			.find((value): value is string => typeof value === 'string' && value.length > 0);

		const searchTopics = (options.searchTopics ?? []).filter(
			(t): t is string => typeof t === 'string' && t.length > 0,
		);

		const logger = {
			warn: (message: string, meta?: Record<string, unknown>) => {
				this.logger.warn(message, meta);
			},
		};

		// Best-effort: read the selected group's scoping from the groups API and
		// surface unmet requirements before hitting Engram. A user-scoped group
		// without a User ID is a hard error (unambiguous). Missing scope-property
		// values are a single warning — store requests can route to any topic, so
		// hard-failing here risks false positives, and Engram returns the
		// authoritative rejection anyway. If the groups call itself fails, skip
		// validation rather than break the run.
		try {
			const groups = await fetchGroups(this);
			const groupName = resolveGroupName(groupId || undefined);
			const { requiresUserId, requiredScopeProperties } = deriveGroupRequirements(
				groups,
				groupName,
			);
			if (requiresUserId && !userId) {
				throw new NodeOperationError(
					this.getNode(),
					`The Engram group "${groupName}" has user-scoped topics, so a User ID is required`,
				);
			}
			// Enforcement is about STORE — every required scope property must have a
			// value to store. Filtering search by them is a separate, optional
			// choice, so we check against the store map only.
			const missing = requiredScopeProperties.filter(
				(property) => !(property in storeScopeProperties),
			);
			if (missing.length > 0) {
				logger.warn(
					`[WeaviateEngram] Group "${groupName}" requires scope ${
						missing.length === 1 ? 'property' : 'properties'
					} "${missing.join('", "')}" but no value was provided. Engram may reject store requests.`,
					{ scope: 'config', group: groupName, missingScopeProperties: missing },
				);
			}
		} catch (error) {
			// Our own validation failure — surface it. Anything else is the groups
			// fetch failing, in which case we skip validation and continue.
			if (error instanceof NodeOperationError) throw error;
		}

		const memory = new EngramMemory({
			config: {
				apiKey: credentials.apiKey,
				baseUrl,
				userId: userId || undefined,
				storeScopeProperties:
					Object.keys(storeScopeProperties).length > 0 ? storeScopeProperties : undefined,
				searchScopeProperties:
					Object.keys(searchScopeProperties).length > 0 ? searchScopeProperties : undefined,
				groupId: groupId || undefined,
				searchLimit: options.searchLimit ?? 10,
				retrievalType,
				storeProperties: fixedCollectionToMap(options.storeProperties),
				searchProperties: fixedCollectionToMap(options.searchProperties),
				searchTopics: searchTopics.length > 0 ? searchTopics : undefined,
				root: options.root && options.root.length > 0 ? options.root : undefined,
				waitForCompletion: options.waitForCompletion ?? false,
				timeoutMs: options.timeoutMs ?? 30000,
				currentInput,
				logger,
			},
			memoryKey: options.advanced?.memoryKey ?? 'chat_history',
			inputKey: options.advanced?.inputKey ?? 'input',
			outputKey: options.advanced?.outputKey ?? 'output',
			returnMessages: true,
		});

		return {
			response: logWrapper(memory, this),
		};
	}
}
