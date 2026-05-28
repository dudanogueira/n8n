import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { jsonParse, type INode, type ISupplyDataFunctions } from 'n8n-workflow';
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
		searchLimit: 10,
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
});

describe('EngramMemory.loadMemoryVariables', () => {
	const config = {
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		userId: USER_ID,
		searchLimit: 5,
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
});

describe('EngramMemory.saveContext', () => {
	const config = {
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		userId: USER_ID,
		searchLimit: 10,
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

describe('MemoryWeaviateEngramChat.supplyData', () => {
	function createCtx(
		overrides: {
			sessionId?: string;
			groupId?: string;
			options?: Record<string, unknown>;
			credentials?: Record<string, unknown>;
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
		// Use customKey mode so the resolved session ID is the raw value (no
		// per-node scoping suffix added). This keeps the assertions about
		// `user_id` predictable in tests; the fromInput/scoped path is exercised
		// indirectly by integration of n8n's session helpers.
		ctx.getNodeParameter.mockImplementation((param) => {
			if (param === 'sessionIdType') return 'customKey';
			if (param === 'sessionKey') return overrides.sessionId ?? USER_ID;
			if (param === 'groupId') return overrides.groupId ?? '';
			if (param === 'options') return overrides.options ?? {};
			return undefined;
		});
		ctx.addInputData.mockReturnValue({ index: 0 });
		ctx.addOutputData.mockReturnValue(undefined);
		ctx.evaluateExpression.mockReturnValue(undefined);
		return ctx;
	}

	it('resolves the session ID and returns a working EngramMemory instance', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({ sessionId: 'session-42' });

		const { response } = await node.supplyData.call(ctx, 0);

		expect(response).toBeDefined();

		// Drive the returned memory and confirm it talks to Engram with the resolved user_id.
		fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
		await (response as EngramMemory).chatHistory.addMessage(new HumanMessage('hi'));

		const body = parseBody(lastFetchCall().init);
		expect(body.user_id).toBe('session-42');
		expect(body.input?.conversation?.messages).toEqual([{ role: 'user', content: 'hi' }]);
	});

	it('forwards Group ID and Options into the EngramMemory', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({
			sessionId: 's1',
			groupId: 'team-a',
			options: { searchLimit: 3, memoryKey: 'history' },
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

	it('throws when no session ID can be resolved', async () => {
		const node = new MemoryWeaviateEngramChat();
		const ctx = createCtx({ sessionId: '' });

		await expect(node.supplyData.call(ctx, 0)).rejects.toThrow(/Key parameter is empty/);
	});
});
