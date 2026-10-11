/**
 * Stands in for `@amazon-devices/kepler-file-system` on Fire OS: the three
 * file calls Wick makes, kept in the app's own key-value storage
 * (storageFileSystem.ts). Android keeps it between launches, so a paired
 * television stays paired — which the Vega simulator's storage does not
 * manage (FRICTION.md FL-013).
 *
 * INV-1 holds as on Vega: the only credential kept here is the device-bound
 * token, and this storage is private to the app but not hardware-backed.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { storageFileSystem } from './storageFileSystem';

export const KeplerFileSystem = storageFileSystem(AsyncStorage);
