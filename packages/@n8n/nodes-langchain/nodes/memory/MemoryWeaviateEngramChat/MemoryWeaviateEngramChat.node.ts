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
	// Default 30000ms matches the Engram Python SDK (httpx timeout=30.0). Node's
	// undici default connect timeout is only 10s, which is what was triggering
	// UND_ERR_CONNECT_TIMEOUT on cold connections from n8n.
	timeoutMs: number;
	// Captured at supplyData time so loadMemoryVariables({}) can still drive a
	// semantic search — the n8n AI Agent calls loadMemoryVariables with no
	// `values`, so we can't read the current input from there.
	currentInput?: string;
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
				// This helper runs inside langchain memory classes, not an n8n
				// execute block, so NodeOperationError isn't usable here.
				// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
				throw new Error(`Engram API error ${response.status}: ${text || response.statusText}`);
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

function logFetchFailure(
	scope: 'search' | 'add',
	url: string,
	error: unknown,
	extra: Record<string, unknown>,
): void {
	const e = error as Error & { cause?: unknown; code?: string };
	const cause = e.cause as
		| { code?: string; errno?: string; syscall?: string; message?: string; hostname?: string }
		| undefined;
	const details = {
		scope,
		url,
		message: e.message,
		code: e.code ?? cause?.code,
		errno: cause?.errno,
		syscall: cause?.syscall,
		hostname: cause?.hostname,
		causeMessage: cause?.message,
		...extra,
	};

	console.warn(`[WeaviateEngram] ${scope} failed:`, JSON.stringify(details));
	if (e.stack) {
		console.warn(`[WeaviateEngram] ${scope} stack:`, e.stack.split('\n').slice(0, 6).join('\n'));
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
		try {
			await engramFetch(
				`${this.config.baseUrl}/v1/memories`,
				this.config.apiKey,
				payload,
				this.config.timeoutMs,
			);
		} catch (error) {
			logFetchFailure('add', `${this.config.baseUrl}/v1/memories`, error, {
				userIdLength: this.config.userId?.length,
				groupIdSet: Boolean(this.config.groupId),
				messageCount: messages.length,
				timeoutMs: this.config.timeoutMs,
			});
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
				retrieval_type: 'hybrid',
				limit: this.config.searchLimit,
			},
			user_id: this.config.userId,
		};
		if (this.config.groupId) payload.group = this.config.groupId;

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
			// Don't take the agent down — but make the failure visible in n8n's
			// execution log so misconfigured user_id / group / retrieval_type
			// issues are diagnosable instead of silently degrading to no memory.
			logFetchFailure('search', `${this.config.baseUrl}/v1/memories/search`, error, {
				userIdLength: this.config.userId?.length,
				groupIdSet: Boolean(this.config.groupId),
				queryLength: query.length,
				timeoutMs: this.config.timeoutMs,
			});
			return [];
		}
	}
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
				description:
					'Optional conversation- or project-level scope (sent as Engram\'s "group" field). When set, both adds and searches are filtered by this group.',
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
						displayName: 'Memory Key',
						name: 'memoryKey',
						type: 'string',
						default: 'chat_history',
						description: 'Key under which retrieved memories are exposed to the prompt template',
					},
					{
						displayName: 'Input Key',
						name: 'inputKey',
						type: 'string',
						default: 'input',
						description: 'Key used to read the current user input when searching Engram',
					},
					{
						displayName: 'Output Key',
						name: 'outputKey',
						type: 'string',
						default: 'output',
						description: 'Key used to read the AI output when saving the turn to Engram',
					},
					{
						displayName: 'Request Timeout (Ms)',
						name: 'timeoutMs',
						type: 'number',
						default: 30000,
						description:
							'Maximum time to wait for an Engram request before aborting. Matches the Engram Python SDK default (30s). Increase if you see UND_ERR_CONNECT_TIMEOUT in the n8n log.',
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
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			searchLimit?: number;
			memoryKey?: string;
			inputKey?: string;
			outputKey?: string;
			timeoutMs?: number;
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

		const memory = new EngramMemory({
			config: {
				apiKey: credentials.apiKey,
				baseUrl,
				userId: sessionId,
				groupId: groupId || undefined,
				searchLimit: options.searchLimit ?? 10,
				timeoutMs: options.timeoutMs ?? 30000,
				currentInput,
			},
			memoryKey: options.memoryKey ?? 'chat_history',
			inputKey: options.inputKey ?? 'input',
			outputKey: options.outputKey ?? 'output',
			returnMessages: true,
		});

		return {
			response: logWrapper(memory, this),
		};
	}
}
