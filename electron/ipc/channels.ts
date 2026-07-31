import channelManifest from './channel-manifest.json' with { type: 'json' };

export const IPC = channelManifest;
export type IPC = (typeof IPC)[keyof typeof IPC];
