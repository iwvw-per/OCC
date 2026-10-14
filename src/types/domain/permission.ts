export type DomainPermissionReply = 'once' | 'always' | 'reject'
export interface DomainPermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
}
