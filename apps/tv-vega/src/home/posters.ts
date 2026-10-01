/**
 * One still per programme, bundled with the app so the home screen never
 * waits on the network. Each is a frame of the film itself, so it carries
 * the film's own licence (CC BY 3.0, Blender Foundation — see catalog.ts).
 *
 * Kept apart from catalog.ts because `require` of an image only resolves
 * inside the Vega bundler; the catalogue stays importable from a test.
 */
import type { ImageSourcePropType } from '@amazon-devices/react-native-kepler';

/* eslint-disable @typescript-eslint/no-require-imports */
export const POSTERS: Readonly<Record<string, ImageSourcePropType>> = {
  'big-buck-bunny': require('../../assets/image/big-buck-bunny.jpg') as ImageSourcePropType,
  sintel: require('../../assets/image/sintel.jpg') as ImageSourcePropType,
  'tears-of-steel': require('../../assets/image/tears-of-steel.jpg') as ImageSourcePropType,
};
/* eslint-enable @typescript-eslint/no-require-imports */
