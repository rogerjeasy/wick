/**
 * Service lifecycle contract.
 * Verified against AmazonAppDev/vega-video-sample/src/headless/HeadlessInterface.ts.
 */
import type { IComponentInstance } from '@amazon-devices/react-native-kepler';

export interface HeadlessServiceInterface {
  onStart(componentInstance: IComponentInstance): Promise<void>;
  onStop(componentInstance: IComponentInstance): Promise<void>;
}
