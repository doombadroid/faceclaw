import { grayImageFromPacket } from './image-files';
import { fromData } from './kotlin-data';
import type { GrayImage } from '../graphics/image';

export function loadIconImage(path: string, maxWidth: number, maxHeight: number): GrayImage | null {
  const data = FaceclawGraphics.decodeImageFileMaxWidthMaxHeight(path, Math.round(maxWidth), Math.round(maxHeight));
  return data ? grayImageFromPacket(fromData(data)) : null;
}
