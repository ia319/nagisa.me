const FONT_LOAD_ERROR_PREFIX = "Font load failed:";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isFontLoadError(error: unknown) {
  return (
    error instanceof Error && error.message.startsWith(FONT_LOAD_ERROR_PREFIX)
  );
}

async function loadGoogleFont(
  font: string,
  text: string,
  weight: number
): Promise<ArrayBuffer> {
  const API = `https://fonts.googleapis.com/css2?family=${font}:wght@${weight}&text=${encodeURIComponent(text)}`;

  try {
    const cssResponse = await fetch(API, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1",
      },
    });

    if (!cssResponse.ok) {
      throw new Error(`CSS request returned ${cssResponse.status}`);
    }

    const css = await cssResponse.text();

    const resource = css.match(
      /src: url\((.+?)\) format\('(opentype|truetype)'\)/
    );

    if (!resource) {
      throw new Error("CSS response did not include a supported font URL");
    }

    const res = await fetch(resource[1]);

    if (!res.ok) {
      throw new Error(`Font request returned ${res.status}`);
    }

    return res.arrayBuffer();
  } catch (error) {
    throw new Error(
      `${FONT_LOAD_ERROR_PREFIX} ${font} ${weight}. ${getErrorMessage(error)}`
    );
  }
}

async function loadGoogleFonts(
  text: string
): Promise<
  Array<{ name: string; data: ArrayBuffer; weight: number; style: string }>
> {
  const fontsConfig = [
    {
      name: "IBM Plex Mono",
      font: "IBM+Plex+Mono",
      weight: 400,
      style: "normal",
    },
    {
      name: "IBM Plex Mono",
      font: "IBM+Plex+Mono",
      weight: 700,
      style: "bold",
    },
  ];

  const fonts = await Promise.all(
    fontsConfig.map(async ({ name, font, weight, style }) => {
      const data = await loadGoogleFont(font, text, weight);
      return { name, data, weight, style };
    })
  );

  return fonts;
}

export default loadGoogleFonts;
