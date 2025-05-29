import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { Embeddings } from '@langchain/core/embeddings';
import { WeaviateStore } from '@langchain/weaviate';
import type { WeaviateLibArgs } from '@langchain/weaviate';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

import { createWeaviateClient } from './Weaviate.utils';
import type { WeaviateCredential } from './Weaviate.utils';
import { createVectorStoreNode } from '../shared/createVectorStoreNode/createVectorStoreNode';
import { weaviateCollectionsSearch } from '../shared/createVectorStoreNode/methods/listSearch';
import { weaviateCollectionRLC } from '../shared/descriptions';

// TODO:
// Add skipInitChecks option to WeaviateStore
// move tenant to sharedFields
// add option timeout options for query, insert and init
// add option grpc proxies

class ExtendedWeaviateVectorStore extends WeaviateStore {
	private static defaultFilter: IDataObject = {};

	static async fromExistingCollection(
		embeddings: Embeddings,
		args: WeaviateLibArgs,
		defaultFilter: IDataObject = {},
	): Promise<WeaviateStore> {
		ExtendedWeaviateVectorStore.defaultFilter = defaultFilter;
		return await super.fromExistingIndex(embeddings, args);
	}

	async similaritySearch(
		query: string,
		k: number,
		filter?: IDataObject,
		callbacks?: Callbacks | undefined,
	) {
		//const mergedFilter = { ...ExtendedWeaviateVectorStore.defaultFilter, ...filter };
		const mergedFilter = undefined;
		return await super.similaritySearch(query, k, mergedFilter, callbacks);
	}
}

const sharedFields: INodeProperties[] = [weaviateCollectionRLC];

const insertFields: INodeProperties[] = [
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Tenant Name',
				name: 'tenant',
				type: 'string',
				default: undefined,
				validateType: 'string',
				description:
					'Tenant Name. If set, any query to this collection must also include a Tenant.',
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
		};

		const credentials = await context.getCredentials('weaviateApi');

		const client = await createWeaviateClient(credentials as WeaviateCredential);

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
