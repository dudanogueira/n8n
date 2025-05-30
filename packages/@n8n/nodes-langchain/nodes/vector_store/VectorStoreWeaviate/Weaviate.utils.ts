import weaviate, { ProxiesParams, TimeoutParams, WeaviateClient } from 'weaviate-client';

export type WeaviateCredential = {
	weaviate_cloud_url: string;
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
	if (credentials.weaviate_cloud_url) {
		let cloud_url = credentials.weaviate_cloud_url.trim();

		if (!/^https?:\/\//i.test(cloud_url)) {
			cloud_url = 'https://' + cloud_url;
		}

		const weaviateClient: WeaviateClient = await weaviate.connectToWeaviateCloud(cloud_url, {
			authCredentials: new weaviate.ApiKey(credentials.weaviate_api_key),
		});
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
