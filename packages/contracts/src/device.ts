/**
 * The device ↔ cloud contract.
 *
 * The transport implementation is a decision gate (SP-5: AWS IoT Core MQTT vs
 * API Gateway WebSocket). This interface is identical either way — build against
 * it and swap the implementation. See docs/WICK-TECHNICAL.md §4.1.
 */
import type { QueuedCard, CardPatch } from './card.js';

export type PlaybackStateName = 'PLAYING' | 'PAUSED' | 'STOPPED' | 'BUFFERING';

/** Derived on-device from the player and content metadata. See §3.4. */
export type BreakState =
  | 'IN_SCENE'
  | 'NEAR_BREAK'
  | 'AT_BREAK'
  | 'TV_SETTLED'
  | 'IDLE';

export type DeviceEvent =
  | {
      readonly t: 'playback';
      readonly state: PlaybackStateName;
      readonly positionMs: number;
      readonly durationMs: number;
      /** The platform's own "episode is ending" signal. See §3.3. */
      readonly creditsPositionMs?: number;
      readonly contentId: string;
      readonly at: number;
    }
  | { readonly t: 'break_state'; readonly state: BreakState; readonly at: number }
  | {
      readonly t: 'card_action';
      readonly cardId: string;
      readonly action: string;
      readonly at: number;
    }
  | { readonly t: 'card_shown'; readonly cardId: string; readonly at: number }
  | { readonly t: 'app_lifecycle'; readonly state: 'fg' | 'bg'; readonly at: number };

export type ControlMessage =
  | { readonly t: 'patch'; readonly patch: CardPatch }
  | { readonly t: 'revoke'; readonly cardId: string }
  | { readonly t: 'reconcile'; readonly sinceCardId?: string };

export type ChannelState = 'connecting' | 'open' | 'backoff' | 'closed';
export type Unsubscribe = () => void;

/**
 * Device-bound JWT. INV-1: assume extractable; scoped to card receipt and
 * playback posting for exactly one household. Grants nothing else.
 */
export interface DeviceToken {
  readonly jwt: string;
  readonly deviceId: string;
  readonly householdId: string;
  readonly expiresAt: number;
}

export interface DeviceChannel {
  connect(token: DeviceToken): Promise<void>;
  onCard(handler: (c: QueuedCard) => void): Unsubscribe;
  onControl(handler: (m: ControlMessage) => void): Unsubscribe;
  send(e: DeviceEvent): Promise<void>;
  readonly state: ChannelState;
}
