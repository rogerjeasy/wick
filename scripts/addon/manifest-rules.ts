/**
 * What Amazon's MCP Toolkit quickstart says an add-on manifest must hold
 * (developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html,
 * field table read 2026-10-11). `alexa-ai deploy` is the real judge of a
 * manifest and Wick cannot run it — the toolkit is open to select partners
 * only (FRICTION.md FL-001) — so the same rules are checked here instead.
 *
 * Pure: a manifest in, the problems out. Nothing here reads a file or the
 * network; preflight.ts does that.
 */

export interface Finding {
  /** Where in the manifest, as a path a person can find: `storeListing.locales.en-US.name.value`. */
  readonly path: string;
  readonly problem: string;
}

/** All six are required for the light theme, and for the dark one if it is given at all. */
export const ICON_SIZES = ['72x72', '64x64', '88x88', '126x126', '180x180', '241x241'] as const;
export const CAROUSEL_SIZE = '600x900';
export const BANNER_SIZE = '1200x600';

const NAME_MAX = 30;
const SHORT_DESCRIPTION_MAX = 123;
const FULL_DESCRIPTION_MAX = 4000;
const PHRASES_MIN = 3;
const PHRASES_MAX = 4;
const PHRASE_MAX = 200;
const ALT_TEXT_MAX = 250;

const TOP_LEVEL_KEYS = ['manifestVersion', 'storeListing', 'integrations'];
const IMAGE_TYPES = /\.(png|jpe?g|webp)$/i;
/** Text a template leaves behind. A deploy would publish it as written. */
const PLACEHOLDER = /SET-FROM|example\.com|TODO|PLACEHOLDER/i;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function httpsUrl(v: unknown): URL | undefined {
  const raw = text(v);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface ManifestImage {
  readonly path: string;
  readonly uri: string;
  /** "72x72" — what the manifest says the file is. */
  readonly size: string;
}

/** The locales of a manifest, or none if it has no store listing. */
function localesOf(manifest: unknown): [string, Json][] {
  if (!isObject(manifest) || !isObject(manifest.storeListing) || !isObject(manifest.storeListing.locales)) return [];
  return Object.entries(manifest.storeListing.locales).filter((entry): entry is [string, Json] => isObject(entry[1]));
}

function imageList(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}

/** Every image the manifest points at, with the size it claims — what the live check downloads. */
export function manifestImages(manifest: unknown): ManifestImage[] {
  const images: ManifestImage[] = [];
  for (const [locale, listing] of localesOf(manifest)) {
    const media = isObject(listing.mediaAssets) ? listing.mediaAssets : {};
    const icons = isObject(media.icons) ? media.icons : {};
    const base = `storeListing.locales.${locale}.mediaAssets`;
    const groups: [string, unknown][] = [
      ['icons.light', icons.light],
      ['icons.dark', icons.dark],
      ['carouselImages', media.carouselImages],
      ['bannerImages', media.bannerImages],
    ];
    for (const [group, list] of groups) {
      imageList(list).forEach((image, i) => {
        const uri = text(image.uri);
        const size = text(image.size);
        if (uri && size) images.push({ path: `${base}.${group}[${i}]`, uri, size });
      });
    }
  }
  return images;
}

/** The privacy policy and terms of every locale. Both must be live pages. */
export function manifestLegalUrls(manifest: unknown): { path: string; uri: string }[] {
  const urls: { path: string; uri: string }[] = [];
  for (const [locale, listing] of localesOf(manifest)) {
    const legal = isObject(listing.privacyAndCompliance) ? listing.privacyAndCompliance : {};
    for (const key of ['privacyPolicyUrl', 'termsOfUseUrl']) {
      const uri = text(legal[key]);
      if (uri) urls.push({ path: `storeListing.locales.${locale}.privacyAndCompliance.${key}`, uri });
    }
  }
  return urls;
}

/** The MCP server the add-on names, or nothing if it names none. */
export function manifestEndpoint(manifest: unknown): string | undefined {
  if (!isObject(manifest) || !Array.isArray(manifest.integrations)) return undefined;
  for (const integration of manifest.integrations) {
    if (!isObject(integration) || integration.type !== 'MCP') continue;
    const config = isObject(integration.config) ? integration.config : {};
    const endpoints = isObject(config.endpoints) ? config.endpoints : {};
    const fallback = isObject(endpoints.default) ? endpoints.default : {};
    return text(fallback.uri);
  }
  return undefined;
}

function checkLength(findings: Finding[], path: string, v: unknown, max: number): void {
  const value = text(v);
  if (!value || !value.trim()) findings.push({ path, problem: 'is required' });
  else if (value.length > max) findings.push({ path, problem: `is ${value.length} characters; the limit is ${max}` });
}

function checkImage(findings: Finding[], path: string, image: Json, size?: string): void {
  if (!httpsUrl(image.uri)) findings.push({ path: `${path}.uri`, problem: 'must be an HTTPS URL' });
  else if (!IMAGE_TYPES.test(new URL(image.uri as string).pathname)) {
    findings.push({ path: `${path}.uri`, problem: 'must be a PNG, JPG, JPEG or WEBP file' });
  }
  if (size !== undefined && image.size !== size) findings.push({ path: `${path}.size`, problem: `must be ${size}` });
}

function checkIcons(findings: Finding[], path: string, v: unknown, required: boolean): void {
  const icons = imageList(v);
  if (icons.length === 0) {
    if (required) findings.push({ path, problem: `needs all six sizes: ${ICON_SIZES.join(', ')}` });
    return;
  }
  for (const size of ICON_SIZES) {
    const count = icons.filter((icon) => icon.size === size).length;
    if (count === 0) findings.push({ path, problem: `has no ${size} icon; all six sizes are required` });
    if (count > 1) findings.push({ path, problem: `has ${count} icons of ${size}` });
  }
  icons.forEach((icon, i) => {
    const size = text(icon.size);
    if (!size || !(ICON_SIZES as readonly string[]).includes(size)) {
      findings.push({ path: `${path}[${i}].size`, problem: `is not one of ${ICON_SIZES.join(', ')}` });
    }
    checkImage(findings, `${path}[${i}]`, icon);
  });
}

function checkPictures(findings: Finding[], path: string, v: unknown, size: string, atLeastOne: boolean): void {
  const pictures = imageList(v);
  if (atLeastOne && pictures.length === 0) findings.push({ path, problem: `needs at least one ${size} image` });
  pictures.forEach((picture, i) => {
    checkImage(findings, `${path}[${i}]`, picture, size);
    checkLength(findings, `${path}[${i}].altText`, picture.altText, ALT_TEXT_MAX);
  });
}

function checkLocale(findings: Finding[], path: string, listing: Json): void {
  const name = isObject(listing.name) ? listing.name : {};
  checkLength(findings, `${path}.name.value`, name.value, NAME_MAX);
  if (name.spokenForm !== undefined && (!isObject(name.spokenForm) || name.spokenForm.format !== 'ipa')) {
    findings.push({ path: `${path}.name.spokenForm`, problem: 'must be {format: "ipa", value}' });
  }
  checkLength(findings, `${path}.shortDescription`, listing.shortDescription, SHORT_DESCRIPTION_MAX);
  checkLength(findings, `${path}.fullDescription`, listing.fullDescription, FULL_DESCRIPTION_MAX);

  const phrases = Array.isArray(listing.examplePhrases) ? listing.examplePhrases : [];
  if (phrases.length < PHRASES_MIN || phrases.length > PHRASES_MAX) {
    findings.push({ path: `${path}.examplePhrases`, problem: `has ${phrases.length} phrases; ${PHRASES_MIN} or ${PHRASES_MAX} are required` });
  }
  phrases.forEach((phrase, i) => checkLength(findings, `${path}.examplePhrases[${i}]`, phrase, PHRASE_MAX));

  const legal = isObject(listing.privacyAndCompliance) ? listing.privacyAndCompliance : {};
  for (const key of ['privacyPolicyUrl', 'termsOfUseUrl']) {
    if (!httpsUrl(legal[key])) findings.push({ path: `${path}.privacyAndCompliance.${key}`, problem: 'must be an HTTPS URL' });
  }

  const media = isObject(listing.mediaAssets) ? listing.mediaAssets : {};
  const icons = isObject(media.icons) ? media.icons : {};
  checkIcons(findings, `${path}.mediaAssets.icons.light`, icons.light, true);
  checkIcons(findings, `${path}.mediaAssets.icons.dark`, icons.dark, false);
  checkPictures(findings, `${path}.mediaAssets.carouselImages`, media.carouselImages, CAROUSEL_SIZE, true);
  checkPictures(findings, `${path}.mediaAssets.bannerImages`, media.bannerImages, BANNER_SIZE, false);
}

function checkPlaceholders(findings: Finding[], path: string, v: unknown): void {
  if (typeof v === 'string') {
    if (PLACEHOLDER.test(v)) findings.push({ path, problem: `still holds placeholder text: "${v.slice(0, 60)}"` });
  } else if (Array.isArray(v)) {
    v.forEach((item, i) => checkPlaceholders(findings, `${path}[${i}]`, item));
  } else if (isObject(v)) {
    for (const [key, value] of Object.entries(v)) checkPlaceholders(findings, path ? `${path}.${key}` : key, value);
  }
}

/** Everything wrong with a manifest. Empty means it holds what the quickstart asks for. */
export function checkManifest(manifest: unknown): Finding[] {
  if (!isObject(manifest)) return [{ path: '', problem: 'the manifest must be a JSON object' }];
  const findings: Finding[] = [];

  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.includes(key)) findings.push({ path: key, problem: 'is not a manifest field; keep notes outside the file' });
  }
  if (manifest.manifestVersion !== '1.0') findings.push({ path: 'manifestVersion', problem: 'must be "1.0"' });

  const listing = isObject(manifest.storeListing) ? manifest.storeListing : {};
  const countries = Array.isArray(listing.distributionCountries) ? listing.distributionCountries : [];
  if (countries.length === 0 || countries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))) {
    findings.push({ path: 'storeListing.distributionCountries', problem: 'must list ISO country codes, for example ["US"]' });
  }

  const locales = localesOf(manifest);
  if (locales.length === 0) findings.push({ path: 'storeListing.locales', problem: 'needs at least one locale' });
  for (const [locale, body] of locales) checkLocale(findings, `storeListing.locales.${locale}`, body);

  const integrations = Array.isArray(manifest.integrations) ? manifest.integrations.filter(isObject) : [];
  const mcp = integrations.findIndex((integration) => integration.type === 'MCP');
  if (mcp < 0) {
    findings.push({ path: 'integrations', problem: 'needs one integration of type "MCP"' });
  } else {
    const path = `integrations[${mcp}].config.endpoints.default`;
    const config = isObject(integrations[mcp]?.config) ? (integrations[mcp]?.config as Json) : {};
    const endpoints = isObject(config.endpoints) ? config.endpoints : {};
    const fallback = isObject(endpoints.default) ? endpoints.default : {};
    if (fallback.type !== 'HTTPS') findings.push({ path: `${path}.type`, problem: 'must be "HTTPS"' });
    if (!httpsUrl(fallback.uri)) findings.push({ path: `${path}.uri`, problem: 'must be the HTTPS URL of the MCP server' });
  }

  checkPlaceholders(findings, '', manifest);
  return findings;
}
