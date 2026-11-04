// Machli Bazzar — Verified Company Logo Ticker Aliases
// Bridges historical symbols, exchange ticker formatting differences, and partly-paid shares
// to the official vector logo identifiers on https://api.dharun.dev/v1/logos/
(function() {
  const LOGO_ALIASES = {
    // 1. Tickers with hyphen formatting differences in API
    'BAJAJ-AUTO': 'BAJAJ_AUTO',
    'NAM-INDIA': 'NAM_INDIA',
    'HCL-INSYS': 'HCL_INSYS',
    'ADVPETR-B': 'ADVPETR_B',
    'BOMOXY-B1': 'BOMOXY_B1',
    'BOSCH-HCIL': 'BOSCH_HCIL',
    'IGLFXPL-B': 'IGLFXPL_B',
    'KIRANSY-B': 'KIRANSY_B',
    'KLBRENG-B': 'KLBRENG_B',
    'MCCHRLS-B': 'MCCHRLS_B',
    'MMRUBBR-B': 'MMRUBBR_B',
    'PARMCOS-B': 'PARMCOS_B',
    'RAMAPPR-B': 'RAMAPPR_B',
    'SUDTIND-B': 'SUDTIND_B',
    'TMTIND-B1': 'TMTIND_B1',
    'UMIYA-MRO': 'UMIYA_MRO',

    // 2. Renamed or alternate corporate trading symbols
    'ICICILIFE': 'ICICIPRULI',
    'EVONILE': 'NOVARTIND',
    'ABCIND': 'ABCOTS',
    'PASURA': 'ABVL',
    'SAHAJDIGI': 'JOLYPLS',
    'SUGALESL': 'SUGALDAM',

    // 3. Partly-paid / rights entitlement shares mapping to parent company logo
    'ACESEPP': 'ACESOFT',
    'ANIRITPP': 'ANIRIT',
    'APLABPP': 'APLAB',
    'ATLPP': 'ATL',
    'CENTEXTPP': 'CENTEXT',
    'GSAILPP': 'GSAUTO',
    'JAYKAYPP': 'JAYKAY',
    'JISLDVREQS': 'JISLJALEQS',
    'SHIVAM-RE1': 'SHIVAMAUTO',
    'VERTEXPP': 'VERTEX'
  };

  if (typeof window !== 'undefined') {
    window.LOGO_ALIASES = LOGO_ALIASES;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LOGO_ALIASES;
  }
})();
