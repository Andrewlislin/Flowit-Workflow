import { FileBridgeAgentAdapter, type FileBridgeAdapterConfig } from '@coaseedge/flowit-adapter-file-bridge'
export const DOUBAO_OFFICE_ADAPTER_ID = 'doubao-office'
export interface DoubaoOfficeAdapterConfig extends Omit<FileBridgeAdapterConfig, 'adapterId'> {}
export class DoubaoOfficeAgentAdapter extends FileBridgeAgentAdapter { constructor(config: DoubaoOfficeAdapterConfig = {}) { super({ adapterId: DOUBAO_OFFICE_ADAPTER_ID, ...config, capabilities: { coldResume: false, liveDispatch: false, skillBinding: true, contextReference: 'summary', eventSubscription: false, ...config.capabilities } }) } }
