import type {
  McpLocalConfig as SDKMcpLocalConfig,
  McpOAuthConfig as SDKMcpOAuthConfig,
  McpResource as SDKMcpResource,
  McpRemoteConfig as SDKMcpRemoteConfig,
  McpStatusResponse as SDKMcpStatusResponse,
  McpStatus as SDKMcpStatus,
} from '@opencode-ai/sdk/v2/client'






export type MCPStatus = SDKMcpStatus

export type MCPResource = SDKMcpResource

export type MCPResourceMap = Record<string, MCPResource>

export type MCPStatusResponse = SDKMcpStatusResponse

export type McpLocalConfig = SDKMcpLocalConfig

export type McpOAuthConfig = SDKMcpOAuthConfig

export type McpRemoteConfig = SDKMcpRemoteConfig

export type McpServerConfig = McpLocalConfig | McpRemoteConfig
