import type { VectorStore } from '@langchain/core/vectorstores';
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { getMetadataFiltersValues, logAiEvent } from '@utils/helpers';

import type { VectorStoreNodeConstructorArgs } from '../types';
import { isDeleteSupported } from '../utils';

/**
 * Handles the 'delete' operation mode
 * Deletes documents from the vector store by ID or filter
 */
export async function handleDeleteOperation<T extends VectorStore = VectorStore>(
	context: IExecuteFunctions,
	args: VectorStoreNodeConstructorArgs<T>,
): Promise<INodeExecutionData[]> {
	// First check if delete operation is supported by this vector store
	if (!isDeleteSupported(args)) {
		throw new NodeOperationError(
			context.getNode(),
			'Delete operation is not implemented for this Vector Store',
		);
	}

	// Get input items
	const items = context.getInputData();
	const resultData: INodeExecutionData[] = [];

	// Process each input item
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		// Get the delete mode: by ID or by filter
		const deleteBy = context.getNodeParameter('deleteBy', itemIndex, 'id') as 'id' | 'filter';

		// Get the vector store client (delete doesn't need embeddings)
		const vectorStore = await args.getVectorStoreClient(
			context,
			undefined,
			undefined as any,
			itemIndex,
		);

		try {
			if (deleteBy === 'id') {
				// Get the document IDs to delete
				const ids = context.getNodeParameter('ids', itemIndex, '') as string;
				const idsArray = ids
					.split(',')
					.map((id) => id.trim())
					.filter((id) => id.length > 0);

				if (idsArray.length === 0) {
					throw new NodeOperationError(
						context.getNode(),
						'At least one ID is required for deletion',
					);
				}

				// Delete documents by IDs
				await vectorStore.delete({ ids: idsArray });

				resultData.push({
					json: { success: true, deletedIds: idsArray },
					pairedItem: { item: itemIndex },
				});
			} else {
				// Get the filter for deletion
				const filter = getMetadataFiltersValues(context, itemIndex);

				if (!filter || Object.keys(filter).length === 0) {
					throw new NodeOperationError(
						context.getNode(),
						'A filter is required when deleting by filter',
					);
				}

				// Delete documents by filter
				await vectorStore.delete({ filter });

				resultData.push({
					json: { success: true, filter },
					pairedItem: { item: itemIndex },
				});
			}

			// Log the AI event for analytics
			logAiEvent(context, 'ai-vector-store-updated');
		} finally {
			// Release the vector store client if a release method was provided
			args.releaseVectorStoreClient?.(vectorStore);
		}
	}

	return resultData;
}
