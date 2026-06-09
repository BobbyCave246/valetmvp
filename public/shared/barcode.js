// Self-contained Code128-B → SVG barcode encoder. No dependencies, no network.
// Exposes window.Barcode.svg(text, opts) returning an <svg> string of bars.
// Encodes printable ASCII (32–126), which covers our bin/location codes.
(function () {
  // Canonical Code 128 patterns, index 0..106. Each digit is the width (in
  // modules) of an element, alternating bar/space starting with a bar.
  // 103 = Start A, 104 = Start B, 105 = Start C, 106 = Stop (7 elements).
  const PATTERNS = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112',
  ];
  const START_B = 104;
  const STOP = 106;

  function values(text) {
    const v = [START_B];
    for (const ch of text) {
      const code = ch.charCodeAt(0) - 32; // Code B: ASCII 32 → value 0
      v.push(code >= 0 && code <= 94 ? code : 0);
    }
    // Modulo-103 checksum, start weight 1, then 1,2,3… for data symbols.
    let sum = START_B;
    for (let i = 1; i < v.length; i++) sum += v[i] * i;
    v.push(sum % 103);
    v.push(STOP);
    return v;
  }

  function svg(text, opts = {}) {
    const { height = 38, moduleWidth = 2, quiet = 10, color = '#0f172a' } = opts;
    const symbols = values(String(text));

    let x = quiet;
    let bars = '';
    for (const sym of symbols) {
      const pattern = PATTERNS[sym];
      let isBar = true; // each pattern starts with a bar
      for (const w of pattern) {
        const width = Number(w) * moduleWidth;
        if (isBar) bars += `<rect x="${x}" y="0" width="${width}" height="${height}" fill="${color}"/>`;
        x += width;
        isBar = !isBar;
      }
    }
    const totalWidth = x + quiet;
    return `<svg class="barcode" xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}" shape-rendering="crispEdges" role="img" aria-label="barcode ${String(text)}">${bars}</svg>`;
  }

  window.Barcode = { svg };
})();
