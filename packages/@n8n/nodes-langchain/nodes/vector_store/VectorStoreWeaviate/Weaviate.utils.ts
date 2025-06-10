import { OperationalError } from 'n8n-workflow';
import type { GeoRangeFilter, ProxiesParams, TimeoutParams, WeaviateClient } from 'weaviate-client';
import weaviate from 'weaviate-client';

export type WeaviateCredential = {
	weaviate_cloud_endpoint: string;
	weaviate_api_key: string;
	custom_connection_http_host: string;
	custom_connection_http_port: number;
	custom_connection_http_secure: boolean;
	custom_connection_grpc_host: string;
	custom_connection_grpc_port: number;
	custom_connection_grpc_secure: boolean;
};

export async function createWeaviateClient(
	credentials: WeaviateCredential,
	timeout?: TimeoutParams,
	proxies?: ProxiesParams,
	skipInitChecks: boolean = false,
): Promise<WeaviateClient> {
	if (credentials.weaviate_cloud_endpoint) {
		const weaviateClient: WeaviateClient = await weaviate.connectToWeaviateCloud(
			credentials.weaviate_cloud_endpoint,
			{
				authCredentials: new weaviate.ApiKey(credentials.weaviate_api_key),
				timeout,
				skipInitChecks,
			},
		);
		return weaviateClient;
	} else {
		const weaviateClient: WeaviateClient = await weaviate.connectToCustom({
			httpHost: credentials.custom_connection_http_host,
			httpPort: credentials.custom_connection_http_port,
			grpcHost: credentials.custom_connection_grpc_host,
			grpcPort: credentials.custom_connection_grpc_port,
			grpcSecure: credentials.custom_connection_grpc_secure,
			httpSecure: credentials.custom_connection_http_secure,
			authCredentials: credentials.weaviate_api_key
				? new weaviate.ApiKey(credentials.weaviate_api_key)
				: undefined,
			timeout,
			proxies,
			skipInitChecks,
		});
		return weaviateClient;
	}
}

export type WeaviateFilterUnit = {
	path: string[];
	operator: string;
	valueString?: string;
	valueTextArray?: string[];
	valueBoolean?: boolean;
	valueNumber?: number;
	valueGeoCoordinates?: GeoRangeFilter;
};

// This function now returns a filter builder from the collection, not Filters
export function returnFilter(filter: WeaviateFilterUnit) {
	const filter_object = weaviate.filter;
	const operator = filter.operator.toLowerCase();
	const property = filter_object.byProperty(filter.path[0]);
	if (operator === 'equal' && filter.valueString) {
		return property.equal(filter.valueString);
	} else if (operator === 'like' && filter.valueString) {
		return property.like(filter.valueString);
	} else if (operator === 'containsany' && filter.valueTextArray) {
		return property.containsAny(filter.valueTextArray);
	} else if (operator === 'containsall' && filter.valueTextArray) {
		return property.containsAll(filter.valueTextArray);
	} else if (operator === 'greaterthan' && filter.valueNumber) {
		return property.greaterThan(filter.valueNumber);
	} else if (operator === 'lessthan' && filter.valueNumber) {
		return property.lessThan(filter.valueNumber);
	} else if (operator === 'isnull' && filter.valueBoolean !== undefined) {
		return property.isNull(filter.valueBoolean);
	} else if (operator === 'withingeorange') {
		if (!filter.valueGeoCoordinates) {
			throw new OperationalError(
				"valueGeoCoordinates must be provided for 'withinGeoRange' operator.",
			);
		}
		return property.withinGeoRange(filter.valueGeoCoordinates);
	}
	throw new OperationalError(`Unsupported operator: ${filter.operator}`);
}
