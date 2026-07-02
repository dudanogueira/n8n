import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
	jsonParse,
	type ILoadOptionsFunctions,
	type INode,
	type ISupplyDataFunctions,
} from 'n8n-workflow';
import { type MockedFunction } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
	EngramChatMessageHistory,
	EngramMemory,
	MemoryWeaviateEngramChat,
} from '../MemoryWeaviateEngramChat.node';

const BASE_URL = 'https://api.engram.weaviate.io';
const API_KEY = 'test-api-key';
const USER_ID = 'alice@example.com';
const CONVERSATION_ID = 'conv-xyz';

interface CapturedBody {
	user_id?: string;
	input?: {
		conversation?: {
			messages?: Array<{ role: string; content: string }>;
		};
	};
	group?: string;
	group_id?: string;
	query?: string;
	retrieval_config?: { retrieval_type: string; limit: number };
	properties?: Record<string, string>;
	topics?: string[];
	root?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function emptyOkResponse(): Response {
	return new Response('{}', {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

let fetchMock: MockedFunction<typeof fetch>;

function urlToString(url: RequestInfo | URL): string {
	if (typeof url === 'string') return url;
	if (url instanceof URL) return url.toString();
	return url.url;
}

function lastFetchCall(): { url: string; init: RequestInit } {
	const calls = fetchMock.mock.calls;
	const [url, init] = calls[calls.length - 1];
	return { url: urlToString(url), init: init ?? {} };
}

function parseBody(init: RequestInit): CapturedBody {
	if (typeof init.body !== 'string') {
		throw new Error('Expected string body in test');
	}
	return jsonParse<CapturedBody>(init.body);
}

beforeEach(() => {
	// Use mockImplementation so each call returns a fresh Response (Response
	// bodies are single-use and would throw on subsequent reads otherwise).
	fetchMock = vi.fn<typeof fetch>();
	fetchMock.mockImplementation(async () => {
		await Promise.resolve();
		return emptyOkResponse();
	});
	global.fetch = fetchMock;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('EngramChatMessageHistory', () => {
	const config = {
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		userId: USER_ID,
		storeScopeProperties: { conversation_id: CONVERSATION_ID },
		searchLimit: 10,
		retrievalType: 'hybrid' as const,
		timeoutMs: 30000,
	};

	it('POSTs a human message to /v1/memories with input.conversation.messages and user_id', async () => {
		const history = new EngramChatMessageHistory(config);

		await history.addMessage(new HumanMessage('hello there'));

		const { url, init } = lastFetchCall();
		expect(url).toBe(`${BASE_URL}/v1/memories`);
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);

		const body = parseBody(init);
		expect(body.user_id).toBe(USER_ID);
		expect(body.input).toEqual({
			conversation: { messages: [{ role: 'user', content: 'hello there' }] },
		});
		expect(body.group).toBeUndefined();
		// The session is always tagged onto stored memories as conversation_id.
		expect(body.properties).toEqual({ conversation_id: CONVERSATION_ID });
	});

	it('maps AIMessage to role=assistant', async () => {
		const history = new EngramChatMessageHistory(config);

		await history.addMessage(new AIMessage('here is an answer'));

		const body = parseBody(lastFetchCall().init);
		expect(body.input?.conversation?.messages).toEqual([
			{ role: 'assistant', content: 'here is an answer' },
		]);
	});

	it('maps SystemMessage to role=system', async () => {
		const history = new EngramChatMessageHistory(config);

		await history.addMessage(new SystemMessage('be concise'));

		const body = parseBody(lastFetchCall().init);
		expect(body.input?.conversation?.messages).toEqual([{ role: 'system', content: 'be concise' }]);
	});

	it('appends to the in-process buffer and returns it via getMessages', async () => {
		const history = new EngramChatMessageHistory(config);

		await history.addMessage(new HumanMessage('one'));
		await history.addMessage(new AIMessage('two'));

		const messages = await history.getMessages();
		expect(messages).toHaveLength(2);
		expect(messages[0]).toBeInstanceOf(HumanMessage);
		expect(messages[1]).toBeInstanceOf(AIMessage);
	});

	it('includes group when set', async () => {
		const history = new EngramChatMessageHistory({ ...config, groupId: 'project-x' });

		await history.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.group).toBe('project-x');
		expect(body.group_id).toBeUndefined();
	});

	it('sends bulk addMessages as a single conversation payload', async () => {
		const history = new EngramChatMessageHistory(config);

		await history.addMessages([new HumanMessage('q'), new AIMessage('a')]);

		expect(fetchMock.mock.calls).toHaveLength(1);
		const body = parseBody(lastFetchCall().init);
		expect(body.input?.conversation?.messages).toEqual([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'a' },
		]);
	});

	it('clear() empties the local buffer without calling Engram', async () => {
		const history = new EngramChatMessageHistory(config);
		await history.addMessage(new HumanMessage('hi'));
		fetchMock.mockClear();

		await history.clear();

		expect((await history.getMessages()).length).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('throws a descriptive error when Engram returns a non-2xx status', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
		);
		const history = new EngramChatMessageHistory(config);

		await expect(history.addMessage(new HumanMessage('hi'))).rejects.toThrow(/403/);
	});

	it('extracts Engram error detail from problem+json bodies', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					status: 422,
					title: 'Unprocessable Entity',
					detail: 'group "myproject" not found',
				}),
				{ status: 422, headers: { 'content-type': 'application/problem+json' } },
			),
		);
		const history = new EngramChatMessageHistory(config);

		await expect(history.addMessage(new HumanMessage('hi'))).rejects.toThrow(
			/group "myproject" not found/,
		);
	});

	it('forwards group + properties context to the n8n logger on failure', async () => {
		const logger = {
			warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
		};
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ status: 422, detail: 'group "x" not found' }), {
				status: 422,
				headers: { 'content-type': 'application/problem+json' },
			}),
		);

		const history = new EngramChatMessageHistory({
			...config,
			groupId: 'x',
			storeProperties: { env: 'prod' },
			root: 'custom',
			logger,
		});

		await expect(history.addMessage(new HumanMessage('hi'))).rejects.toThrow();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const [message, meta] = logger.warn.mock.calls[0];
		expect(message).toContain('add failed');
		expect(meta).toMatchObject({
			scope: 'add',
			status: 422,
			group: 'x',
			root: 'custom',
			storeProperties: { env: 'prod' },
		});
	});

	it('sends properties when storeProperties is configured', async () => {
		const history = new EngramChatMessageHistory({
			...config,
			storeProperties: { env: 'prod', channel: 'slack' },
		});

		await history.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({
			env: 'prod',
			channel: 'slack',
			conversation_id: CONVERSATION_ID,
		});
	});

	it('sends root when configured', async () => {
		const history = new EngramChatMessageHistory({
			...config,
			root: 'custom-pipeline',
		});

		await history.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.root).toBe('custom-pipeline');
	});

	it('sends only conversation_id in properties and omits root by default', async () => {
		const history = new EngramChatMessageHistory(config);

		await history.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ conversation_id: CONVERSATION_ID });
		expect(body.root).toBeUndefined();
	});

	it('omits user_id when no User ID is configured (project-scoped)', async () => {
		const history = new EngramChatMessageHistory({ ...config, userId: undefined });

		await history.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.user_id).toBeUndefined();
	});

	it('omits properties entirely when no scope properties or tags are configured', async () => {
		const history = new EngramChatMessageHistory({ ...config, storeScopeProperties: undefined });

		await history.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toBeUndefined();
	});

	it('sends user-defined tags without scope properties when none are configured', async () => {
		const history = new EngramChatMessageHistory({
			...config,
			storeScopeProperties: undefined,
			storeProperties: { env: 'prod' },
		});

		await history.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ env: 'prod' });
	});

	it('polls /v1/runs/{run_id} when waitForCompletion is true', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ run_id: 'run-123', status: 'running' }));
		fetchMock.mockResolvedValueOnce(jsonResponse({ run_id: 'run-123', status: 'completed' }));

		const history = new EngramChatMessageHistory({
			...config,
			waitForCompletion: true,
		});

		await history.addMessage(new HumanMessage('hi'));

		expect(fetchMock.mock.calls).toHaveLength(2);
		expect(lastFetchCall().url).toBe(`${BASE_URL}/v1/runs/run-123`);
		expect(lastFetchCall().init.method).toBe('GET');
	});
});

describe('EngramMemory.loadMemoryVariables', () => {
	const config = {
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		userId: USER_ID,
		searchLimit: 5,
		retrievalType: 'hybrid' as const,
		timeoutMs: 30000,
	};

	it('POSTs the current input as the search query and returns Engram memories as system messages', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				memories: [
					{ content: 'User prefers dark mode' },
					{ content: 'User prefers concise replies' },
				],
				total: 2,
			}),
		);

		const memory = new EngramMemory({ config, returnMessages: true });
		const variables = await memory.loadMemoryVariables({ input: 'What are my preferences?' });

		const { url, init } = lastFetchCall();
		expect(url).toBe(`${BASE_URL}/v1/memories/search`);
		const body = parseBody(init);
		expect(body).toEqual({
			query: 'What are my preferences?',
			retrieval_config: { retrieval_type: 'hybrid', limit: 5 },
			user_id: USER_ID,
		});

		const messages = variables.chat_history as SystemMessage[];
		expect(messages).toHaveLength(2);
		expect(messages[0]).toBeInstanceOf(SystemMessage);
		expect(messages[0].content).toContain('User prefers dark mode');
	});

	it('forwards group when configured', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({
			config: { ...config, groupId: 'support-chat' },
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'foo' });

		const body = parseBody(lastFetchCall().init);
		expect(body.group).toBe('support-chat');
		expect(body.group_id).toBeUndefined();
	});

	it('falls back to an empty history when the search request fails', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response('boom', { status: 500, statusText: 'Server Error' }),
		);

		const memory = new EngramMemory({ config, returnMessages: true });
		const variables = await memory.loadMemoryVariables({ input: 'whatever' });

		expect(variables.chat_history).toEqual([]);
	});

	it('silently treats 422 "user not found" as a cold-start empty result', async () => {
		const logger = {
			warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
		};
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ status: 422, detail: 'user "User222" not found' }), {
				status: 422,
				headers: { 'content-type': 'application/problem+json' },
			}),
		);

		const memory = new EngramMemory({
			config: { ...config, logger },
			returnMessages: true,
		});
		const variables = await memory.loadMemoryVariables({ input: 'whatever' });

		expect(variables.chat_history).toEqual([]);
		// Critically: nothing logged — this is an expected cold-start path,
		// not a misconfiguration the user needs to see.
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('still logs 422 errors that are not "user not found"', async () => {
		const logger = {
			warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
		};
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ status: 422, detail: 'group "ghost" not found' }), {
				status: 422,
				headers: { 'content-type': 'application/problem+json' },
			}),
		);

		const memory = new EngramMemory({
			config: { ...config, logger },
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'q' });

		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('logs structured search-failure context to the n8n logger', async () => {
		const logger = {
			warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
		};
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ status: 422, detail: 'group "ghost" not found' }), {
				status: 422,
				headers: { 'content-type': 'application/problem+json' },
			}),
		);

		const memory = new EngramMemory({
			config: {
				...config,
				groupId: 'ghost',
				retrievalType: 'bm25',
				searchTopics: ['support'],
				logger,
			},
			returnMessages: true,
		});
		const variables = await memory.loadMemoryVariables({ input: 'whatever' });

		expect(variables.chat_history).toEqual([]);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const [message, meta] = logger.warn.mock.calls[0];
		expect(message).toContain('search failed');
		expect(message).toContain('group "ghost" not found');
		expect(meta).toMatchObject({
			scope: 'search',
			status: 422,
			group: 'ghost',
			retrievalType: 'bm25',
			searchTopics: ['support'],
		});
	});

	it('skips the search when no input is provided', async () => {
		const memory = new EngramMemory({ config, returnMessages: true });

		const variables = await memory.loadMemoryVariables({});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(variables.chat_history).toEqual([]);
	});

	it('uses currentInput captured at supplyData time when values is empty (n8n AI Agent path)', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ memories: [{ content: 'Alice likes pasta' }], total: 1 }),
		);

		const memory = new EngramMemory({
			config: { ...config, currentInput: 'What does Alice eat?' },
			returnMessages: true,
		});
		const variables = await memory.loadMemoryVariables({});

		const body = parseBody(lastFetchCall().init);
		expect(body.query).toBe('What does Alice eat?');
		expect((variables.chat_history as SystemMessage[])[0].content).toContain('Alice likes pasta');
	});

	it('falls back to the last buffered HumanMessage when no values and no currentInput', async () => {
		const memory = new EngramMemory({ config, returnMessages: true });
		await memory.chatHistory.addMessages([
			new HumanMessage('first question'),
			new AIMessage('first answer'),
			new HumanMessage('second question'),
		]);
		fetchMock.mockClear();
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		await memory.loadMemoryVariables({});

		const body = parseBody(lastFetchCall().init);
		expect(body.query).toBe('second question');
	});

	it('returns a plain string when returnMessages is false', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ memories: [{ content: 'remembers your name' }], total: 1 }),
		);

		const memory = new EngramMemory({ config, returnMessages: false });
		const variables = await memory.loadMemoryVariables({ input: 'who am i' });

		expect(typeof variables.chat_history).toBe('string');
		expect(variables.chat_history).toContain('remembers your name');
	});

	it('exposes results under a custom memoryKey', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [{ content: 'x' }], total: 1 }));

		const memory = new EngramMemory({ config, memoryKey: 'history', returnMessages: true });
		const variables = await memory.loadMemoryVariables({ input: 'q' });

		expect(variables.history).toBeDefined();
		expect(variables.chat_history).toBeUndefined();
	});

	it.each(['vector', 'bm25', 'hybrid'] as const)(
		'sends retrieval_type=%s from config',
		async (retrievalType) => {
			fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

			const memory = new EngramMemory({
				config: { ...config, retrievalType },
				returnMessages: true,
			});
			await memory.loadMemoryVariables({ input: 'q' });

			const body = parseBody(lastFetchCall().init);
			expect(body.retrieval_config?.retrieval_type).toBe(retrievalType);
		},
	);

	it('sends topics array when configured', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({
			config: { ...config, searchTopics: ['support', 'onboarding'] },
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.topics).toEqual(['support', 'onboarding']);
	});

	it('sends search properties map when configured', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({
			config: { ...config, searchProperties: { tenant: 'acme' } },
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ tenant: 'acme' });
	});

	it('omits topics and properties when not configured', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({ config, returnMessages: true });
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.topics).toBeUndefined();
		expect(body.properties).toBeUndefined();
	});

	it('omits user_id on search when no User ID is configured (project-scoped)', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({
			config: { ...config, userId: undefined },
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.user_id).toBeUndefined();
	});

	it('does not send properties on search when no scope properties are configured', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({ config, returnMessages: true });
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toBeUndefined();
	});

	it('sends the scope properties chosen to filter search', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({
			config: { ...config, searchScopeProperties: { conversation_id: CONVERSATION_ID } },
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ conversation_id: CONVERSATION_ID });
	});

	it('does not filter search by a scope property left out of searchScopeProperties', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		// storeScopeProperties is set but searchScopeProperties is not — the value
		// is stored (elsewhere) yet search stays broad, recalling across values.
		const memory = new EngramMemory({
			config: { ...config, storeScopeProperties: { conversation_id: CONVERSATION_ID } },
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toBeUndefined();
	});

	it('merges search scope properties with searchProperties on search', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));

		const memory = new EngramMemory({
			config: {
				...config,
				searchScopeProperties: { conversation_id: CONVERSATION_ID },
				searchProperties: { tenant: 'acme' },
			},
			returnMessages: true,
		});
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ tenant: 'acme', conversation_id: CONVERSATION_ID });
	});
});

describe('EngramMemory.saveContext', () => {
	const config = {
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		userId: USER_ID,
		storeScopeProperties: { conversation_id: CONVERSATION_ID },
		searchLimit: 10,
		retrievalType: 'hybrid' as const,
		timeoutMs: 30000,
	};

	it('pushes the input and output as a single bulk add to Engram', async () => {
		const memory = new EngramMemory({ config });

		await memory.saveContext({ input: 'q' }, { output: 'a' });

		expect(fetchMock.mock.calls).toHaveLength(1);
		const body = parseBody(lastFetchCall().init);
		expect(body.input?.conversation?.messages).toEqual([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'a' },
		]);
	});

	it('skips empty input or output strings', async () => {
		const memory = new EngramMemory({ config });

		await memory.saveContext({ input: 'q' }, { output: '' });

		const body = parseBody(lastFetchCall().init);
		expect(body.input?.conversation?.messages).toEqual([{ role: 'user', content: 'q' }]);
	});

	it('does not call Engram when both sides are empty', async () => {
		const memory = new EngramMemory({ config });

		await memory.saveContext({ input: '' }, { output: '' });

		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('MemoryWeaviateEngramChat node description', () => {
	const node = new MemoryWeaviateEngramChat();

	it('declares the AiMemory output and credential', () => {
		expect(node.description.displayName).toBe('Weaviate Engram');
		expect(node.description.name).toBe('memoryWeaviateEngramChat');
		expect(node.description.icon).toBe('file:weaviate.svg');
		expect(node.description.outputs).toEqual(['ai_memory']);
		expect(node.description.credentials).toEqual([{ name: 'weaviateEngramApi', required: true }]);
	});
});

describe('MemoryWeaviateEngramChat.methods.loadOptions', () => {
	const GROUP_LIST = {
		groups: [
			{
				group_id: '019f16e6-6af1-7c2c-b17b-fb83d6a8c11a',
				name: 'default',
				topics: [
					{
						topic_name: 'ConversationSummary',
						description: 'A summary of the conversation',
						scoping: { user_scoped: true, scope_properties: ['conversation_id'] },
					},
					{
						topic_name: 'UserProfile',
						description: 'Stable facts about the user',
						scoping: { user_scoped: true },
					},
				],
			},
			{
				group_id: '019f16e6-6af1-7c2c-b17b-fb83d6a8c11b',
				name: 'support',
				topics: [
					{
						topic_name: 'UserProfile',
						description: 'Stable facts about the user',
						scoping: { user_scoped: true },
					},
					{
						topic_name: 'TicketContext',
						description: 'Details of the support ticket',
						scoping: { user_scoped: true, scope_properties: ['session_id', 'ticket_id'] },
					},
				],
			},
		],
	};

	function createLoadOptionsCtx(selectedGroup?: string) {
		const ctx = mock<ILoadOptionsFunctions>();
		ctx.getCredentials.mockResolvedValue({ apiKey: API_KEY, baseUrl: BASE_URL });
		ctx.getCurrentNodeParameter.mockReturnValue(selectedGroup);
		const httpMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
		httpMock.mockResolvedValue(GROUP_LIST);
		ctx.helpers.httpRequestWithAuthentication =
			httpMock as unknown as typeof ctx.helpers.httpRequestWithAuthentication;
		return { ctx, httpMock };
	}

	it('getGroups lists group names from GET /v1/groups', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx, httpMock } = createLoadOptionsCtx();

		const options = await node.methods.loadOptions.getGroups.call(ctx);

		expect(httpMock).toHaveBeenCalledWith(
			'weaviateEngramApi',
			expect.objectContaining({ method: 'GET', url: `${BASE_URL}/v1/groups` }),
		);
		expect(options.map((o) => o.name)).toEqual(['default', 'support']);
		expect(options.map((o) => o.value)).toEqual(['default', 'support']);
	});

	it('getGroups returns an empty list when the project has no groups', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx, httpMock } = createLoadOptionsCtx();
		httpMock.mockResolvedValue({ groups: [] });

		const options = await node.methods.loadOptions.getGroups.call(ctx);

		expect(options).toEqual([]);
	});

	it('getTopics lists de-duplicated topics across all groups when none is selected', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx } = createLoadOptionsCtx(undefined);

		const options = await node.methods.loadOptions.getTopics.call(ctx);

		expect(options).toEqual([
			{
				name: 'ConversationSummary',
				value: 'ConversationSummary',
				description: 'A summary of the conversation',
			},
			{
				name: 'TicketContext',
				value: 'TicketContext',
				description: 'Details of the support ticket',
			},
			{ name: 'UserProfile', value: 'UserProfile', description: 'Stable facts about the user' },
		]);
	});

	it('getTopics scopes topics to the selected group', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx } = createLoadOptionsCtx('support');

		const options = await node.methods.loadOptions.getTopics.call(ctx);

		expect(options.map((o) => o.value)).toEqual(['TicketContext', 'UserProfile']);
	});

	it('getScopeProperties lists scope properties plus user_id for a user-scoped group', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx } = createLoadOptionsCtx('support');

		const options = await node.methods.loadOptions.getScopeProperties.call(ctx);

		// Union across the support group's topics, including user_id (topics are
		// user-scoped), sorted.
		expect(options.map((o) => o.value)).toEqual(['session_id', 'ticket_id', 'user_id']);
	});

	it('getScopeProperties omits user_id when no topic is user-scoped', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx, httpMock } = createLoadOptionsCtx('support');
		httpMock.mockResolvedValue({
			groups: [
				{
					name: 'support',
					topics: [{ topic_name: 'TicketContext', scoping: { scope_properties: ['ticket_id'] } }],
				},
			],
		});

		const options = await node.methods.loadOptions.getScopeProperties.call(ctx);

		expect(options.map((o) => o.value)).toEqual(['ticket_id']);
	});

	it('getScopeProperties lists the union across all groups when none is selected', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx } = createLoadOptionsCtx(undefined);

		const options = await node.methods.loadOptions.getScopeProperties.call(ctx);

		// Union across every group, de-duplicated and sorted — never empty just
		// because no group is picked yet.
		expect(options.map((o) => o.value)).toEqual([
			'conversation_id',
			'session_id',
			'ticket_id',
			'user_id',
		]);
	});

	it('getScopeProperties falls back to the union when the selected group has no match', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx } = createLoadOptionsCtx('does-not-exist');

		const options = await node.methods.loadOptions.getScopeProperties.call(ctx);

		expect(options.map((o) => o.value)).toEqual([
			'conversation_id',
			'session_id',
			'ticket_id',
			'user_id',
		]);
	});

	it('getScopeProperties still resolves when the sibling group value cannot be read', async () => {
		const node = new MemoryWeaviateEngramChat();
		const { ctx } = createLoadOptionsCtx(undefined);
		ctx.getCurrentNodeParameter.mockImplementation(() => {
			throw new Error('cannot read nested parameter');
		});

		const options = await node.methods.loadOptions.getScopeProperties.call(ctx);

		expect(options.map((o) => o.value)).toEqual([
			'conversation_id',
			'session_id',
			'ticket_id',
			'user_id',
		]);
	});
});

describe('MemoryWeaviateEngramChat.supplyData', () => {
	// A single scope-property row for the fixedCollection mapper.
	type ScopeRow = {
		name?: string;
		source?: 'value' | 'session';
		value?: string;
		filterSearch?: boolean;
	};

	function createCtx(
		overrides: {
			userId?: string;
			sessionId?: string;
			scopeProperties?: ScopeRow[];
			groupId?: string;
			retrievalType?: 'hybrid' | 'vector' | 'bm25';
			options?: Record<string, unknown>;
			credentials?: Record<string, unknown>;
			// Response for the best-effort GET /v1/groups requirement check in
			// supplyData. Defaults to no groups (no enforcement).
			groups?: unknown;
		} = {},
	) {
		const ctx = mock<ISupplyDataFunctions>();
		ctx.getNode.mockReturnValue({
			name: 'Weaviate Engram',
			typeVersion: 1,
			parameters: {},
		} as INode);
		ctx.getCredentials.mockResolvedValue({
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			...overrides.credentials,
		});
		ctx.getNodeParameter.mockImplementation((param) => {
			if (param === 'userId') return overrides.userId ?? USER_ID;
			if (param === 'scopeProperties')
				return overrides.scopeProperties ? { property: overrides.scopeProperties } : {};
			if (param === 'groupId') return overrides.groupId ?? '';
			if (param === 'retrievalType') return overrides.retrievalType ?? 'hybrid';
			if (param === 'options') return overrides.options ?? {};
			return undefined;
		});
		// supplyData does a best-effort GET /v1/groups to check requirements.
		const groupsMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
		groupsMock.mockResolvedValue(overrides.groups ?? { groups: [] });
		ctx.helpers.httpRequestWithAuthentication =
			groupsMock as unknown as typeof ctx.helpers.httpRequestWithAuthentication;
		ctx.logger.warn = vi.fn() as unknown as typeof ctx.logger.warn;
		ctx.addInputData.mockReturnValue({ index: 0 });
		ctx.addOutputData.mockReturnValue(undefined);
		// A scope property mapped to "N8n Session ID" resolves the session by
		// evaluating {{ $json.sessionId }} — mirror the Chat Trigger providing it.
		ctx.evaluateExpression.mockImplementation((expression: string) =>
			typeof expression === 'string' && expression.includes('sessionId')
				? (overrides.sessionId ?? CONVERSATION_ID)
				: undefined,
		);
		ctx.getChatTrigger.mockReturnValue(null);
		return ctx;
	}

	it('sends the User ID as user_id and maps the session into a scope property', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			userId: 'alice@example.com',
			sessionId: 'session-42',
			scopeProperties: [{ name: 'conversation_id', source: 'session' }],
		});

		const { response } = await node.supplyData.call(ctx, 0);

		expect(response).toBeDefined();

		// Drive the returned memory and confirm it talks to Engram with the
		// configured user_id and the session mapped into the scope property.
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.user_id).toBe('alice@example.com');
		expect(body.properties).toEqual({ conversation_id: 'session-42' });
		expect(body.input?.conversation?.messages).toEqual([{ role: 'user', content: 'hi' }]);
	});

	it('maps a scope property to a static value', async () => {
		const node = new MemoryWeaviateEngramChat();
		const scopeName = 'tenant_id';
		const ctx = createCtx({
			sessionId: 's1',
			scopeProperties: [{ name: scopeName, source: 'value', value: 'acme' }],
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ tenant_id: 'acme' });
	});

	it('routes a user_id scope row to the top-level user_id, not into properties', async () => {
		const node = new MemoryWeaviateEngramChat();
		const scopeName = 'user_id';
		const ctx = createCtx({
			userId: '',
			sessionId: 's1',
			scopeProperties: [
				{ name: scopeName, source: 'value', value: 'bob@example.com' },
				{ name: 'conversation_id', source: 'session' },
			],
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.user_id).toBe('bob@example.com');
		expect(body.properties).toEqual({ conversation_id: 's1' });
	});

	it('prefers the dedicated User ID field over a mapped user_id scope row', async () => {
		const node = new MemoryWeaviateEngramChat();
		const scopeName = 'user_id';
		const ctx = createCtx({
			userId: 'alice@example.com',
			sessionId: 's1',
			scopeProperties: [{ name: scopeName, source: 'value', value: 'bob@example.com' }],
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.user_id).toBe('alice@example.com');
	});

	it('forwards Group ID and Options into the EngramMemory', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			groupId: 'team-a',
			options: { searchLimit: 3, advanced: { memoryKey: 'history' } },
		});

		const { response } = await node.supplyData.call(ctx, 0);
		const memory = response as EngramMemory;

		expect(memory.memoryKey).toBe('history');

		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await memory.loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.group).toBe('team-a');
		expect(body.retrieval_config).toEqual({ retrieval_type: 'hybrid', limit: 3 });
	});

	it('strips trailing slashes from the base URL', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			credentials: { apiKey: API_KEY, baseUrl: `${BASE_URL}//` },
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		expect(lastFetchCall().url).toBe(`${BASE_URL}/v1/memories`);
	});

	it('omits user_id (project-scoped) when User ID is empty', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({ userId: '' });

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.user_id).toBeUndefined();
	});

	it('does not require a session when no scope property maps to it', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({ sessionId: '' });

		// No throw even though the session ID is empty.
		const { response } = await node.supplyData.call(ctx, 0);
		expect(response).toBeDefined();
	});

	it('throws when a scope property maps to the session but no session ID can be resolved', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: '',
			scopeProperties: [{ name: 'conversation_id', source: 'session' }],
		});

		await expect(node.supplyData.call(ctx, 0)).rejects.toThrow(/No session ID found/);
	});

	it('forwards retrievalType from the top-level parameter', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({ sessionId: 's1', retrievalType: 'vector' });

		const { response } = await node.supplyData.call(ctx, 0);

		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await (response as EngramMemory).loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.retrieval_config?.retrieval_type).toBe('vector');
	});

	it('converts fixedCollection storeProperties to a flat map', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			options: {
				storeProperties: {
					property: [
						{ key: 'env', value: 'prod' },
						{ key: 'channel', value: 'slack' },
					],
				},
			},
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ env: 'prod', channel: 'slack' });
	});

	it('merges scope properties with storeProperties on writes', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			scopeProperties: [{ name: 'conversation_id', source: 'session' }],
			options: {
				storeProperties: { property: [{ key: 'env', value: 'prod' }] },
			},
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ env: 'prod', conversation_id: 's1' });
	});

	it('converts fixedCollection searchProperties to a flat map', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			options: {
				searchProperties: {
					property: [{ key: 'tenant', value: 'acme' }],
				},
			},
		});

		const { response } = await node.supplyData.call(ctx, 0);

		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await (response as EngramMemory).loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ tenant: 'acme' });
	});

	it('does not send properties on writes when nothing is configured', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({ sessionId: 's1' });

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toBeUndefined();
	});

	it('sends the mapped scope property on search too by default', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			scopeProperties: [{ name: 'conversation_id', source: 'session' }],
		});

		const { response } = await node.supplyData.call(ctx, 0);

		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await (response as EngramMemory).loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toEqual({ conversation_id: 's1' });
	});

	it('stores but does not filter search by a scope property with filterSearch off', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			scopeProperties: [{ name: 'conversation_id', source: 'session', filterSearch: false }],
		});

		const { response } = await node.supplyData.call(ctx, 0);
		const memory = response as EngramMemory;

		// Store tags the value...
		await memory.chatHistory.addMessage(new HumanMessage('hi'));
		expect(parseBody(lastFetchCall().init).properties).toEqual({ conversation_id: 's1' });

		// ...but search stays broad (no properties sent).
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await memory.loadMemoryVariables({ input: 'q' });
		expect(parseBody(lastFetchCall().init).properties).toBeUndefined();
	});

	it('forwards searchTopics from options', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			options: { searchTopics: ['support', 'onboarding'] },
		});

		const { response } = await node.supplyData.call(ctx, 0);

		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await (response as EngramMemory).loadMemoryVariables({ input: 'q' });

		const body = parseBody(lastFetchCall().init);
		expect(body.topics).toEqual(['support', 'onboarding']);
	});

	it('drops empty fixedCollection rows', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			options: {
				storeProperties: {
					property: [{ key: '', value: 'ignored' }],
				},
			},
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toBeUndefined();
	});

	it('drops scope-property rows with an empty property name', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			scopeProperties: [{ name: '', source: 'value', value: 'ignored' }],
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.properties).toBeUndefined();
	});

	it('throws when the group has user-scoped topics but no User ID is set', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			userId: '',
			sessionId: 's1',
			groupId: 'default',
			groups: {
				groups: [
					{
						name: 'default',
						topics: [{ topic_name: 'UserProfile', scoping: { user_scoped: true } }],
					},
				],
			},
		});

		await expect(node.supplyData.call(ctx, 0)).rejects.toThrow(/User ID is required/);
	});

	it('warns (but does not throw) when a required scope property has no value', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			groupId: 'default',
			groups: {
				groups: [
					{
						name: 'default',
						topics: [
							{
								topic_name: 'ConversationSummary',
								scoping: { scope_properties: ['conversation_id'] },
							},
						],
					},
				],
			},
		});

		const { response } = await node.supplyData.call(ctx, 0);
		expect(response).toBeDefined();

		const warn = ctx.logger.warn as unknown as MockedFunction<
			(message: string, meta?: Record<string, unknown>) => void
		>;
		expect(warn).toHaveBeenCalledTimes(1);
		const [message, meta] = warn.mock.calls[0];
		expect(message).toContain('conversation_id');
		expect(meta).toMatchObject({ missingScopeProperties: ['conversation_id'] });
	});

	it('does not throw when the groups requirement check itself fails', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({ userId: '', sessionId: 's1' });
		const groupsMock = ctx.helpers.httpRequestWithAuthentication as unknown as MockedFunction<
			(...args: unknown[]) => Promise<unknown>
		>;
		groupsMock.mockRejectedValue(new Error('groups API unreachable'));

		const { response } = await node.supplyData.call(ctx, 0);
		expect(response).toBeDefined();
	});
});
