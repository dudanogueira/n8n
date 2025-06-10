import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { Embeddings } from '@langchain/core/embeddings';
import { WeaviateStore } from '@langchain/weaviate';
import type { WeaviateLibArgs } from '@langchain/weaviate';
import type { INodeProperties, INodePropertyCollection, INodePropertyOptions } from 'n8n-workflow';
import { Filters, type ProxiesParams, type TimeoutParams } from 'weaviate-client';
import type { WeaviateCredential, WeaviateFilterUnit } from './Weaviate.utils';
import { createWeaviateClient, returnFilter } from './Weaviate.utils';
import { createVectorStoreNode } from '../shared/createVectorStoreNode/createVectorStoreNode';
import { weaviateCollectionsSearch } from '../shared/createVectorStoreNode/methods/listSearch';
import { weaviateCollectionRLC } from '../shared/descriptions';

// TODO:
// Add json with filter
// validate textKey
// use metadatakeys

class ExtendedWeaviateVectorStore extends WeaviateStore {
	static async fromExistingCollection(
		embeddings: Embeddings,
		args: WeaviateLibArgs,
	): Promise<WeaviateStore> {
		return await super.fromExistingIndex(embeddings, args);
	}

	async similaritySearch(
		query: string,
		k: number,
		filter?: WeaviateFilterUnit[],
		callbacks?: Callbacks | undefined,
	) {
		if (filter) {
			const result_filters = filter.map((filter_item: WeaviateFilterUnit) =>
				returnFilter(filter_item),
			);
			return await super.similaritySearch(query, k, Filters.and(...result_filters), callbacks);
		} else {
			return await super.similaritySearch(query, k, undefined, callbacks);
		}
	}
}

const sharedFields: INodeProperties[] = [weaviateCollectionRLC];

const shared_options: Array<INodePropertyOptions | INodeProperties | INodePropertyCollection> = [
	{
		displayName: 'Tenant Name',
		name: 'tenant',
		type: 'string',
		default: undefined,
		validateType: 'string',
		description: 'Tenant Name. Collection must have been created with tenant support enabled.',
	},
	{
		displayName: 'Text Key',
		name: 'textKey',
		type: 'string',
		default: 'text',
		validateType: 'string',
		description: 'The key in the document that contains the embedded text',
	},
	{
		displayName: 'Skip Init Checks',
		name: 'skip_init_checks',
		type: 'boolean',
		default: false,
		validateType: 'boolean',
		description: 'Whether to skip init checks while instantiating the client',
	},
	{
		displayName: 'Init Timeout',
		name: 'timeout_init',
		type: 'number',
		default: 2,
		validateType: 'number',
		description: 'Number of timeout seconds for initial checks',
	},
	{
		displayName: 'Insert Timeout',
		name: 'timeout_insert',
		type: 'number',
		default: 90,
		validateType: 'number',
		description: 'Number of timeout seconds for inserts',
	},
	{
		displayName: 'Query Timeout',
		name: 'timeout_query',
		type: 'number',
		default: 30,
		validateType: 'number',
		description: 'Number of timeout seconds for queries',
	},
	{
		displayName: 'GRPC Proxy',
		name: 'proxy_grpc',
		type: 'string',
		default: undefined,
		validateType: 'string',
		description: 'Proxy to use for GRPC',
	},
];

const insertFields: INodeProperties[] = [
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			...shared_options,
			{
				displayName: 'Clear Data',
				name: 'clearStore',
				type: 'boolean',
				default: false,
				description: 'Whether to clear the Collection/Tenant before inserting new data',
			},
		],
	},
];

const retrieveFields: INodeProperties[] = [
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Search Filter',
				name: 'searchFilterJson',
				type: 'json',
				typeOptions: {
					rows: 5,
				},
				default:
					'{\n  "should": [\n    {\n      "key": "metadata.batch",\n      "match": {\n        "value": 12345\n      }\n    }\n  ]\n}',
				validateType: 'object',
				description:
					'Filter pageContent or metadata using this <a href="https://weaviate.io/" target="_blank">filtering syntax</a>',
			},
			...shared_options,
		],
	},
];

export class VectorStoreWeaviate extends createVectorStoreNode<ExtendedWeaviateVectorStore>({
	meta: {
		displayName: 'Weaviate Vector Store',
		name: 'vectorStoreWeaviate',
		description: 'Work with your data in a Weaviate Cluster',
		icon: 'file:weaviate.svg',
		docsUrl:
			'https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreweaviate/',
		credentials: [
			{
				name: 'weaviateApi',
				required: true,
			},
		],
	},
	methods: {
		listSearch: { weaviateCollectionsSearch },
	},
	loadFields: retrieveFields,
	insertFields,
	sharedFields,
	retrieveFields,
	async getVectorStoreClient(context, filter, embeddings, itemIndex) {
		const collection = context.getNodeParameter('weaviateCollection', itemIndex, '', {
			extractValue: true,
		}) as string;

		const options = context.getNodeParameter('options', itemIndex, {}) as {
			tenant?: string;
			textKey?: string;
			timeout_init: number;
			timeout_insert: number;
			timeout_query: number;
			skip_init_checks: boolean;
			proxy_grpc: string;
		};

		const credentials = await context.getCredentials('weaviateApi');

		const timeout = {
			query: options.timeout_query,
			init: options.timeout_init,
			insert: options.timeout_insert,
		};

		const proxies = {
			grpc: options.proxy_grpc,
		};

		const client = await createWeaviateClient(
			credentials as WeaviateCredential,
			timeout as TimeoutParams,
			proxies as ProxiesParams,
			options.skip_init_checks as boolean,
		);

		const config: WeaviateLibArgs = {
			client,
			indexName: collection,
			tenant: options.tenant ? options.tenant : undefined,
			textKey: options.textKey ? options.textKey : 'text',
		};

		return await ExtendedWeaviateVectorStore.fromExistingCollection(embeddings, config, filter);
	},
	async populateVectorStore(context, embeddings, documents, itemIndex) {
		const collectionName = context.getNodeParameter('weaviateCollection', itemIndex, '', {
			extractValue: true,
		}) as string;

		const options = context.getNodeParameter('options', itemIndex, {}) as {
			tenant?: string;
			textKey?: string;
			clearStore?: boolean;
		};

		const credentials = await context.getCredentials('weaviateApi');

		const client = await createWeaviateClient(credentials as WeaviateCredential);

		const config: WeaviateLibArgs = {
			client,
			indexName: collectionName,
			tenant: options.tenant ? options.tenant : undefined,
			textKey: options.textKey ? options.textKey : 'text',
		};

		if (options.clearStore) {
			if (!options.tenant) {
				await client.collections.delete(collectionName);
			} else {
				const collection = client.collections.get(collectionName);
				await collection.tenants.remove([{ name: options.tenant }]);
			}
		}

		await WeaviateStore.fromDocuments(documents, embeddings, config);
	},
}) {}
