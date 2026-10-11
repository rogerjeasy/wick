import { describe, expect, it } from 'vitest';
import { ICON_SIZES, checkManifest, manifestEndpoint, manifestImages, manifestLegalUrls } from '../addon/manifest-rules.js';
import { pngSize, sizeLabel } from '../addon/image-size.js';

/** A manifest with nothing wrong with it. Each test below breaks one thing. */
function valid() {
  return {
    manifestVersion: '1.0',
    storeListing: {
      distributionCountries: ['US'],
      locales: {
        'en-US': {
          default: 'DEFAULT',
          name: { value: 'Wick', spokenForm: { format: 'ipa', value: 'wɪk' } },
          shortDescription: 'Ask how someone living alone has been this week.',
          fullDescription: 'Ask how the week has been, in plain language.',
          examplePhrases: ['how has my mum been this week', 'did the carer come today', "is everything all right at mum's"],
          privacyAndCompliance: {
            privacyPolicyUrl: 'https://wick.test/privacy.html',
            termsOfUseUrl: 'https://wick.test/terms.html',
          },
          mediaAssets: {
            icons: {
              light: ICON_SIZES.map((size) => ({ size, uri: `https://wick.test/icons/light-${size}.png` })),
              dark: [] as { size: string; uri: string }[],
            },
            carouselImages: [{ uri: 'https://wick.test/carousel/1.png', altText: 'A calm card on a television.', size: '600x900' }],
            bannerImages: [] as { uri: string; altText: string; size: string }[],
          },
        },
      },
    },
    integrations: [{ type: 'MCP', config: { endpoints: { default: { type: 'HTTPS', uri: 'https://mcp.wick.test/mcp' } } } }],
  };
}

const listing = (m: ReturnType<typeof valid>) => m.storeListing.locales['en-US'];
const problemsAt = (manifest: unknown, path: string) => checkManifest(manifest).filter((f) => f.path.startsWith(path));

describe('checkManifest', () => {
  it('finds nothing wrong with a manifest that holds what the quickstart asks for', () => {
    expect(checkManifest(valid())).toEqual([]);
  });

  it('refuses anything that is not an object', () => {
    expect(checkManifest('addon')).toHaveLength(1);
    expect(checkManifest(null)).toHaveLength(1);
  });

  it('refuses a manifest version other than 1.0', () => {
    expect(problemsAt({ ...valid(), manifestVersion: '2.0' }, 'manifestVersion')).toHaveLength(1);
  });

  it('refuses a note key at the top level — a deploy would send it to Amazon as a field', () => {
    expect(problemsAt({ ...valid(), _comment: 'set the endpoint' }, '_comment')).toHaveLength(1);
  });

  it('refuses a missing or malformed country list', () => {
    const none = valid();
    none.storeListing.distributionCountries = [];
    const lower = valid();
    lower.storeListing.distributionCountries = ['us'];

    expect(problemsAt(none, 'storeListing.distributionCountries')).toHaveLength(1);
    expect(problemsAt(lower, 'storeListing.distributionCountries')).toHaveLength(1);
  });

  it('refuses a name over 30 characters, and an empty one', () => {
    const long = valid();
    listing(long).name.value = 'W'.repeat(31);
    const empty = valid();
    listing(empty).name.value = ' ';

    expect(problemsAt(long, 'storeListing.locales.en-US.name.value')[0]?.problem).toContain('31');
    expect(problemsAt(empty, 'storeListing.locales.en-US.name.value')).toHaveLength(1);
  });

  it('accepts a manifest with no spoken form, and refuses one that is not IPA', () => {
    const without = valid();
    delete (listing(without).name as { spokenForm?: unknown }).spokenForm;
    const arpabet = valid();
    listing(arpabet).name.spokenForm.format = 'arpabet';

    expect(checkManifest(without)).toEqual([]);
    expect(problemsAt(arpabet, 'storeListing.locales.en-US.name.spokenForm')).toHaveLength(1);
  });

  it('holds the short description to 123 characters and the full one to 4000', () => {
    const m = valid();
    listing(m).shortDescription = 's'.repeat(124);
    listing(m).fullDescription = 'f'.repeat(4001);

    expect(problemsAt(m, 'storeListing.locales.en-US.shortDescription')).toHaveLength(1);
    expect(problemsAt(m, 'storeListing.locales.en-US.fullDescription')).toHaveLength(1);
  });

  it('wants three or four example phrases, each 200 characters at most', () => {
    const two = valid();
    listing(two).examplePhrases = ['one', 'two'];
    const five = valid();
    listing(five).examplePhrases = ['1', '2', '3', '4', '5'];
    const long = valid();
    listing(long).examplePhrases[1] = 'p'.repeat(201);

    expect(problemsAt(two, 'storeListing.locales.en-US.examplePhrases')).toHaveLength(1);
    expect(problemsAt(five, 'storeListing.locales.en-US.examplePhrases')).toHaveLength(1);
    expect(problemsAt(long, 'storeListing.locales.en-US.examplePhrases[1]')).toHaveLength(1);
  });

  it('wants both legal pages over HTTPS', () => {
    const m = valid();
    listing(m).privacyAndCompliance.privacyPolicyUrl = 'http://wick.test/privacy.html';
    listing(m).privacyAndCompliance.termsOfUseUrl = '';

    expect(problemsAt(m, 'storeListing.locales.en-US.privacyAndCompliance')).toHaveLength(2);
  });

  it('wants all six light icons, once each', () => {
    const missing = valid();
    listing(missing).mediaAssets.icons.light.pop();
    const twice = valid();
    listing(twice).mediaAssets.icons.light.push({ size: '72x72', uri: 'https://wick.test/icons/again.png' });
    const none = valid();
    listing(none).mediaAssets.icons.light = [];

    expect(problemsAt(missing, 'storeListing.locales.en-US.mediaAssets.icons.light')[0]?.problem).toContain('241x241');
    expect(problemsAt(twice, 'storeListing.locales.en-US.mediaAssets.icons.light')[0]?.problem).toContain('2 icons');
    expect(problemsAt(none, 'storeListing.locales.en-US.mediaAssets.icons.light')).toHaveLength(1);
  });

  it('lets the dark icons be absent, and wants all six once any is given', () => {
    const some = valid();
    listing(some).mediaAssets.icons.dark = [{ size: '72x72', uri: 'https://wick.test/icons/dark-72.png' }];

    expect(problemsAt(some, 'storeListing.locales.en-US.mediaAssets.icons.dark')).toHaveLength(5);
  });

  it('refuses an image that is not HTTPS, or not a PNG, JPG, JPEG or WEBP', () => {
    const m = valid();
    const light = listing(m).mediaAssets.icons.light;
    light[0] = { size: '72x72', uri: 'http://wick.test/icons/light-72.png' };
    light[1] = { size: '64x64', uri: 'https://wick.test/icons/light-64.svg' };

    expect(problemsAt(m, 'storeListing.locales.en-US.mediaAssets.icons.light[0].uri')).toHaveLength(1);
    expect(problemsAt(m, 'storeListing.locales.en-US.mediaAssets.icons.light[1].uri')).toHaveLength(1);
  });

  it('wants at least one 600x900 carousel image with alt text of 250 characters at most', () => {
    const none = valid();
    listing(none).mediaAssets.carouselImages = [];
    const wrong = valid();
    listing(wrong).mediaAssets.carouselImages[0] = { uri: 'https://wick.test/c.png', altText: 'a'.repeat(251), size: '900x600' };

    expect(problemsAt(none, 'storeListing.locales.en-US.mediaAssets.carouselImages')).toHaveLength(1);
    expect(problemsAt(wrong, 'storeListing.locales.en-US.mediaAssets.carouselImages[0]').map((f) => f.path).sort()).toEqual([
      'storeListing.locales.en-US.mediaAssets.carouselImages[0].altText',
      'storeListing.locales.en-US.mediaAssets.carouselImages[0].size',
    ]);
  });

  it('holds a banner, if there is one, to 1200x600', () => {
    const m = valid();
    listing(m).mediaAssets.bannerImages = [{ uri: 'https://wick.test/banner.png', altText: 'Wick', size: '600x900' }];

    expect(problemsAt(m, 'storeListing.locales.en-US.mediaAssets.bannerImages[0].size')).toHaveLength(1);
  });

  it('wants one MCP integration with an HTTPS endpoint', () => {
    const none = { ...valid(), integrations: [] };
    const plain = valid();
    plain.integrations[0]!.config.endpoints.default = { type: 'HTTP', uri: 'http://mcp.wick.test/mcp' };

    expect(problemsAt(none, 'integrations')).toHaveLength(1);
    expect(problemsAt(plain, 'integrations[0].config.endpoints.default').map((f) => f.path).sort()).toEqual([
      'integrations[0].config.endpoints.default.type',
      'integrations[0].config.endpoints.default.uri',
    ]);
  });

  it('finds text a template left behind, wherever it is', () => {
    const m = valid();
    m.integrations[0]!.config.endpoints.default.uri = 'SET-FROM-WICKMCP-STACK-OUTPUT';
    listing(m).privacyAndCompliance.termsOfUseUrl = 'https://example.com/terms';

    const placeholders = checkManifest(m).filter((f) => f.problem.includes('placeholder'));
    expect(placeholders.map((f) => f.path).sort()).toEqual([
      'integrations[0].config.endpoints.default.uri',
      'storeListing.locales.en-US.privacyAndCompliance.termsOfUseUrl',
    ]);
  });
});

describe('what the live check reads from a manifest', () => {
  it('lists every image with the size it claims', () => {
    const images = manifestImages(valid());

    expect(images).toHaveLength(7);
    expect(images[0]).toEqual({
      path: 'storeListing.locales.en-US.mediaAssets.icons.light[0]',
      uri: 'https://wick.test/icons/light-72x72.png',
      size: '72x72',
    });
    expect(images.at(-1)?.size).toBe('600x900');
  });

  it('lists both legal pages', () => {
    expect(manifestLegalUrls(valid()).map((u) => u.uri)).toEqual(['https://wick.test/privacy.html', 'https://wick.test/terms.html']);
  });

  it('names the MCP endpoint, or nothing when there is none', () => {
    expect(manifestEndpoint(valid())).toBe('https://mcp.wick.test/mcp');
    expect(manifestEndpoint({ integrations: [] })).toBeUndefined();
    expect(manifestEndpoint(undefined)).toBeUndefined();
  });
});

describe('pngSize', () => {
  /** The first 24 bytes of a PNG that is `width` by `height`. */
  const pngHeader = (width: number, height: number) => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  };

  it('reads the width and height from the header', () => {
    const size = pngSize(pngHeader(600, 900));

    expect(size).toEqual({ width: 600, height: 900 });
    expect(sizeLabel(size!)).toBe('600x900');
  });

  it('reads a header that sits part-way into a larger buffer', () => {
    const padded = new Uint8Array(40);
    padded.set(pngHeader(72, 72), 8);

    expect(pngSize(padded.subarray(8))).toEqual({ width: 72, height: 72 });
  });

  it('has no answer for a file that is not a PNG, or is cut short', () => {
    expect(pngSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(30).fill(0)]))).toBeUndefined();
    expect(pngSize(pngHeader(72, 72).subarray(0, 20))).toBeUndefined();
  });
});
