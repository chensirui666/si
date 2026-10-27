# Local font assets

All three fonts are distributed under SIL Open Font License 1.1. Keep the accompanying license files and copyright notices when redistributing these assets.

| Asset | Internal family | Supplied weights | Official source |
| --- | --- | --- | --- |
| `noto-sans-cjk-sc-variable.woff2` | Noto Sans CJK SC | Variable 100–900; UI uses 400, 500, 600 | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Variable/TTF/NotoSansCJKsc-VF.ttf) |
| `noto-sans-mono-cjk-sc-regular.woff2` | Noto Sans Mono CJK SC | 400 | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Mono/NotoSansMonoCJKsc-Regular.otf) |
| `eb-garamond-regular.woff2` | EB Garamond | 400 | [google/fonts](https://github.com/google/fonts/blob/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf) |

The Noto fonts retain the complete upstream SC font glyph set, including 44,810 encoded characters and 65,535 glyphs each. No character subset was selected from current UI text or assumed user input. SC selects Simplified Chinese forms; it does not mean the font covers every Unicode character. The single body variable font avoids distributing separate files for 400, 500, and 600. EB Garamond is instantiated at the only specified design weight, 400, without removing glyphs.

These are local WOFF2 conversions using fontTools; no npm dependency or runtime font service is required. `font-display: swap` shows text while the font loads. Full CJK coverage makes the first body font download relatively large; the browser loads the Mono face only when it is used.

The WOFF2 assets total 25,818,744 bytes: body 14,249,460 bytes, Mono 11,411,024 bytes, and EB Garamond 158,260 bytes. The two CJK files retain their upstream glyphs, character maps, family names, and copyright metadata; conversion only changes their packaging to WOFF2.

## Copyright and licenses

- Noto Sans CJK SC: © 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
- Noto Sans Mono CJK SC: © 2014-2021 Adobe (http://www.adobe.com/).
- EB Garamond: Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12).

[Noto CJK OFL](OFL-Noto-CJK.txt) is copied from the [official license](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE). [EB Garamond OFL](OFL-EB-Garamond.txt) is copied from its [official license](https://github.com/google/fonts/blob/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/ebgaramond/OFL.txt). The copyright and license metadata inside the font files is preserved.
