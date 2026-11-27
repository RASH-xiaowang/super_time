import type { PersonalityMomentImageRef } from './portrait-personality.ts';
export interface PortraitVisionImage {
    dataUrl: string;
    mediaType: string;
    source: 'chat' | 'moment';
}
export declare function loadPortraitVisionImages(input: {
    decryptedDir: string;
    decodedDir: string;
    talker: string;
    localIds: readonly number[];
    momentImages: readonly PersonalityMomentImageRef[];
    wechatBaseDir?: string;
    aesKey?: string;
    xorKey: number;
}): Promise<PortraitVisionImage[]>;
