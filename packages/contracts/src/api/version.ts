export interface RuntimeDescriptorInfo {
  readonly appId: 'studio.readable.desktop';
  readonly appVersion: string;
  readonly descriptorHash: '9d1181594e3733ae67c685c6e1529baa1f095a19d93ec9739445a15643ab0c3a';
  readonly productId: 'readable-studio';
  readonly protocolVersion: 1;
  readonly runtimeVersion: 1;
}

export interface AppVersionInfo {
  readonly version: string;
  readonly channel: string;
  readonly packaged: boolean;
  readonly platform: string;
  readonly arch: string;
}

export interface AppVersionResponse {
  readonly descriptor: RuntimeDescriptorInfo;
  readonly version: AppVersionInfo;
}

export interface DaemonHealthResponse {
  readonly descriptor: RuntimeDescriptorInfo;
  readonly ok: true;
  readonly version: string;
}
