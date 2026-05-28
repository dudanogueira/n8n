import { BaseChatMemory } from '@langchain/community/memory/chat_memory';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { InputValues, MemoryVariables, OutputValues } from '@langchain/core/memory';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { logWrapper, getConnectionHintNoticeField } from '@n8n/ai-utilities';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import { getSessionId } from '@utils/helpers';

import {
	expressionSessionKeyProperty,
	sessionIdOption,
	sessionKeyProperty,
	scopedSessionHint,
} from '../descriptions';

interface EngramConfig {
	apiKey: string;
	baseUrl: string;
	userId: string;
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
			user_id: this.config.userId,
		};
		if (this.config.groupId) payload.group = this.config.groupId;
		if (this.config.storeProperties && Object.keys(this.config.storeProperties).length > 0) {
			payload.properties = this.config.storeProperties;
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
			user_id: this.config.userId,
		};
		if (this.config.groupId) payload.group = this.config.groupId;
		if (this.config.searchTopics && this.config.searchTopics.length > 0) {
			payload.topics = this.config.searchTopics;
		}
		if (this.config.searchProperties && Object.keys(this.config.searchProperties).length > 0) {
			payload.properties = this.config.searchProperties;
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
						url: 'https://docs.engram.weaviate.io/',
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
					'The session ID is sent to Engram as the <code>user_id</code>. Engram retrieves long-term memories scoped to this value and stores new turns under it.',
				name: 'sessionIdNotice',
				type: 'notice',
				default: '',
			},
			sessionIdOption,
			expressionSessionKeyProperty(1),
			scopedSessionHint(1),
			sessionKeyProperty,
			{
				displayName: 'Group',
				name: 'groupId',
				type: 'string',
				default: '',
				placeholder: 'default',
				hint: 'The group must already exist in your Engram project. Leave empty to fall back to the "default" group.',
				description:
					'Optional conversation- or project-level scope (sent as Engram\'s "group" field). When set, both adds and searches are filtered by this group. Engram does not auto-create groups — if you see "group not found" errors, create the group in your Engram project first, or leave this empty to use the built-in "default" group.',
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
						displayName: 'Search Topics',
						name: 'searchTopics',
						type: 'string',
						typeOptions: { multipleValues: true },
						default: [],
						placeholder: 'Add Topic',
						description:
							'Restrict search to these Engram topics. Leave empty to search across all topics.',
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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials<{
			apiKey: string;
			baseUrl: string;
		}>('weaviateEngramApi');

		const sessionId = getSessionId(this, itemIndex);
		if (!sessionId) {
			throw new NodeOperationError(
				this.getNode(),
				'A session ID is required to scope Engram memories',
			);
		}

		const groupId = (this.getNodeParameter('groupId', itemIndex, '') as string).trim();
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

		const memory = new EngramMemory({
			config: {
				apiKey: credentials.apiKey,
				baseUrl,
				userId: sessionId,
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
