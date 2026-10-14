export interface DomainModel {
  id: string
  modelID: string
  providerID: string
  name: string
  status?: string
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
}
export interface DomainProvider {
  id: string
  name: string
  models?: Record<string, DomainModel>
}
