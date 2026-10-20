/**
 * One of Lucide's icons, drawn with the platform's own `Image`
 * (icons/icons.ts says which picture). The same in a tile, a pill, the
 * film's bar and a card.
 *
 * Never alone for a meaning (docs/design/DESIGN.md §5): give it a word
 * beside it, and then it is hidden from the screen reader, which reads the
 * word; or give it `label`, and the screen reader says that.
 */
import * as React from 'react';
import { Image } from '@amazon-devices/react-native-kepler';
import { useCalmTheme } from '@wick/vega-calm-ui';
import { ICON_SOURCES } from './iconSources.generated.js';
import { iconKey, iconSizeDp, type IconName, type IconTone } from './icons.js';

export interface IconProps {
  readonly name: IconName;
  /** `ground` on an amber first button; `ink` everywhere else. */
  readonly tone?: IconTone | undefined;
  /** What the screen reader says for it, when no word stands beside it. */
  readonly label?: string | undefined;
}

export function Icon({ name, tone = 'ink', label }: IconProps): React.JSX.Element | null {
  const theme = useCalmTheme();
  const source = ICON_SOURCES[iconKey(name, tone, theme)];
  if (!source) return null;
  const size = iconSizeDp(theme);
  return (
    <Image
      source={source}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessible={label !== undefined}
      accessibilityRole={label !== undefined ? 'image' : undefined}
      accessibilityLabel={label ?? ''}
      importantForAccessibility={label !== undefined ? 'yes' : 'no-hide-descendants'}
    />
  );
}
