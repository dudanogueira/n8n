import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class WeaviateEngramApi implements ICredentialType {
	name = 'weaviateEngramApi';

	displayName = 'Weaviate Engram Credentials';

	documentationUrl = 'https://docs.engram.weaviate.io/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Your Weaviate Engram API key',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: 'https://api.engram.weaviate.io',
			description: 'Engram API base URL. Override to point at a self-hosted or staging deployment.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/memories/search',
			method: 'POST',
			body: {
				query: 'connection test',
				retrieval_config: {
					retrieval_type: 'hybrid',
					limit: 1,
				},
			},
		},
	};
}
