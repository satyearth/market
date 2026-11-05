'use strict';

const fs = require('fs');
const path = require('path');
const DATA_PATH = path.join(__dirname, '..', 'js', 'stocks-data.js');
let cached = null;

const SECTOR_OVERRIDES = {
  'INE0BJO01010': { sector: 'Telecommunication', industry: 'Telecom - Services' }, // JPL (Jio Platforms Limited)
  'INE721I01024': { sector: 'Financial Services', industry: 'Capital Markets' }, // NSE (National Stock Exchange)
  'INE931S01010': { sector: 'Power', industry: 'Power - Transmission' }, // ADANIENSOL (Adani Energy Solutions)
  'INE0V6F01027': { sector: 'Automobile and Auto Components', industry: 'Automobiles' }, // HYUNDAI (Hyundai Motor India)
  'INE323A01026': { sector: 'Automobile and Auto Components', industry: 'Auto Components' }, // BOSCHLTD (Bosch Limited)
  'INE1TAE01010': { sector: 'Automobile and Auto Components', industry: 'Commercial Vehicles' }, // TMCV (Tata Motors)
  'INE1CDF01017': { sector: 'Metals & Mining', industry: 'Aluminium' }, // VAML (Vedanta Aluminium Metal)
  'INE976I01016': { sector: 'Financial Services', industry: 'Non Banking Financial Company (NBFC)' }, // TATACAP (Tata Capital)
  'INE346A01027': { sector: 'Financial Services', industry: 'Asset Management' }, // ICICIAMC (ICICI Prudential AMC)
  'INE669E01016': { sector: 'Telecommunication', industry: 'Telecom - Cellular & Fixed line' }, // IDEA (Vodafone Idea)
  'INE0HOQ01053': { sector: 'Financial Services', industry: 'Stockbroking & Allied' }, // GROWW (Billionbrains Garage Ventures)
  'INE07Y701011': { sector: 'Capital Goods', industry: 'Heavy Electrical Equipment' }, // POWERINDIA (Hitachi Energy India)
  'INE214T01019': { sector: 'Information Technology', industry: 'IT Services & Consulting' }, // LTM (Ltm Limited)
  'INE053A01029': { sector: 'Consumer Services', industry: 'Hotels & Resorts' }, // INDHOTEL (Indian Hotels)
  'INE956O01016': { sector: 'Consumer Services', industry: 'Specialty Retail' }, // LENSKART (Lenskart Solutions)
  'INE010B01027': { sector: 'Healthcare', industry: 'Pharmaceuticals' }, // ZYDUSLIFE (Zydus Lifesciences)
  'INE749A01030': { sector: 'Metals & Mining', industry: 'Iron & Steel' }, // JINDALSTEL (Jindal Steel)
  'INE196A01026': { sector: 'Fast Moving Consumer Goods', industry: 'Edible Oil & Personal Care' }, // MARICO (Marico)
  'INE118A01012': { sector: 'Financial Services', industry: 'Holding Company' }, // BAJAJHLDNG (Bajaj Holdings)
  'INE562A01011': { sector: 'Financial Services', industry: 'Public Sector Bank' }, // INDIANB (Indian Bank)
  'INE324D01010': { sector: 'Consumer Durables', industry: 'Consumer Electronics' }, // LGEINDIA (LG Electronics India)
  'INE670K01029': { sector: 'Realty', industry: 'Real Estate' }, // LODHA (Lodha Developers)
  'INE982J01020': { sector: 'Financial Services', industry: 'Financial Technology (Fintech)' }, // PAYTM (One 97 Communications)
  'INE200A01026': { sector: 'Capital Goods', industry: 'Heavy Electrical Equipment' }, // GVT&D (GE Vernova T&D India)
  'INE127D01025': { sector: 'Financial Services', industry: 'Asset Management' }, // HDFCAMC (HDFC AMC)
  'INE134E01011': { sector: 'Financial Services', industry: 'Financial Institution' }, // PFC (Power Finance Corporation)
  'INE1NPP01017': { sector: 'Capital Goods', industry: 'Heavy Electrical Equipment' }, // ENRIN (Siemens Energy India)
  'INE634S01028': { sector: 'Healthcare', industry: 'Pharmaceuticals' }, // MANKIND (Mankind Pharma)
  'INE0VDM01015': { sector: 'Consumer Services', industry: 'E-Commerce' }, // MEESHO (Meesho Limited)
  'INE854D01024': { sector: 'Fast Moving Consumer Goods', industry: 'Beverages' }, // UNITDSPR (United Spirits)
  'INE155A01022': { sector: 'Automobile and Auto Components', industry: 'Automobiles' }, // TMPV (Tata Motors Passenger Vehicles)
  'INE121J01017': { sector: 'Telecommunication', industry: 'Telecom - Infrastructure' }, // INDUSTOWER (Indus Towers)
  'INE053F01010': { sector: 'Financial Services', industry: 'Financial Institution' }, // IRFC (Indian Railway Finance)
  'INE388Y01029': { sector: 'Consumer Services', industry: 'E-Commerce' }, // NYKAA (FSN E-Commerce Ventures)
  'INE640G01020': { sector: 'Financial Services', industry: 'Asset Management' }, // SBIFUNDS (SBI Funds Management)
  'INE776C01039': { sector: 'Services', industry: 'Airport Operations' }, // GMRAIRPORT (GMR Airports)
  'INE281B01032': { sector: 'Metals & Mining', industry: 'Iron & Steel' }, // LLOYDSME (Lloyds Metals And Energy)
  'INE881D01027': { sector: 'Information Technology', industry: 'Enterprise Software' }, // OFSS (Oracle Financial Services Software)
  'INE465A01025': { sector: 'Automobile and Auto Components', industry: 'Auto Components' }, // BHARATFORG (Bharat Forge)
  'INE459N01021': { sector: 'Healthcare', industry: 'Hospital & Healthcare Services' }, // MANIPALHOS (Manipal Health Enterprises)
  'INE070A01015': { sector: 'Construction Materials', industry: 'Cement & Cement Products' }, // SHREECEM (Shree Cement)
  'INE343G01021': { sector: 'Telecommunication', industry: 'Telecom - Services' }, // BHARTIHEXA (Bharti Hexacom)
  'INE008A01015': { sector: 'Financial Services', industry: 'Private Sector Bank' }, // IDBI (IDBI Bank)
  'INE880J01026': { sector: 'Services', industry: 'Port & Port Services' }, // JSWINFRA (JSW Infrastructure)
  'INE765G01017': { sector: 'Financial Services', industry: 'General Insurance' }, // ICICIGI (ICICI Lombard)
  'INE094A01015': { sector: 'Oil Gas & Consumable Fuels', industry: 'Refineries & Marketing' }, // HINDPETRO (HPCL)
  'INE663F01032': { sector: 'Consumer Services', industry: 'Internet & Web Portals' }, // NAUKRI (Info Edge)
  'INE020B01018': { sector: 'Financial Services', industry: 'Financial Institution' }, // RECLTD (REC Limited)
  'INE274J01014': { sector: 'Oil Gas & Consumable Fuels', industry: 'Oil Exploration & Production' }, // OIL (Oil India)
  'INE249Z01020': { sector: 'Capital Goods', industry: 'Shipbuilding' }, // MAZDOCK (Mazagon Dock Shipbuilders)
  'INE0LEZ01016': { sector: 'Automobile and Auto Components', industry: 'Electric Vehicles' }, // ATHERENERG (Ather Energy)
  'INE114A01011': { sector: 'Metals & Mining', industry: 'Iron & Steel' }, // SAIL (Steel Authority of India)
  'INE0ONG01011': { sector: 'Power', industry: 'Renewable Energy' }, // NTPCGREEN (NTPC Green Energy)
  'INE377N01017': { sector: 'Capital Goods', industry: 'Solar Energy Equipment' }, // WAAREEENER (Waaree Energies)
  'INE405E01023': { sector: 'Automobile and Auto Components', industry: 'Auto Components' }, // UNOMINDA (Uno Minda)
  'INE949L01017': { sector: 'Financial Services', industry: 'Small Finance Bank' }, // AUBANK (AU Small Finance Bank)
  'INE377Y01014': { sector: 'Financial Services', industry: 'Housing Finance' }, // BAJAJHFL (Bajaj Housing Finance)
  'INE372A01015': { sector: 'Capital Goods', industry: 'Electrical Cables & Wires' }, // APARINDS (Apar Industries)
  'INE498L01015': { sector: 'Financial Services', industry: 'Non Banking Financial Company (NBFC)' }, // LTF (L&T Finance)
  'INE298J01013': { sector: 'Financial Services', industry: 'Asset Management' }, // NAM-INDIA (Nippon Life India AMC)
  'INE191B01025': { sector: 'Metals & Mining', industry: 'Iron & Steel Products' }, // WELCORP (Welspun Corp)
  'INE399L01023': { sector: 'Oil Gas & Consumable Fuels', industry: 'City Gas Distribution' }, // ATGL (Adani Total Gas)
  'INE726G01019': { sector: 'Financial Services', industry: 'Life Insurance' }, // ICICIPRULI (ICICI Prudential Life)
  'INE457A01014': { sector: 'Financial Services', industry: 'Public Sector Bank' }, // MAHABANK (Bank of Maharashtra)
  'INE584A01023': { sector: 'Metals & Mining', industry: 'Minerals & Mining' }, // NMDC (NMDC)
  'INE084101034': { sector: 'Capital Goods', industry: 'Precision Engineering' }, // INDOMIM (Indo-Mim)
  'INE084A01016': { sector: 'Financial Services', industry: 'Public Sector Bank' }, // BANKINDIA (Bank of India)
  'INE702C01027': { sector: 'Capital Goods', industry: 'Structural Steel Tubes' }, // APLAPOLLO (APL Apollo Tubes)
  'INE139A01034': { sector: 'Metals & Mining', industry: 'Aluminium' }, // NATIONALUM (National Aluminium)
  'INE944F01028': { sector: 'Fast Moving Consumer Goods', industry: 'Distilleries & Wineries' }, // RADICO (Radico Khaitan)
  'INE565A01014': { sector: 'Financial Services', industry: 'Public Sector Bank' }, // IOB (Indian Overseas Bank)
  'INE358A01014': { sector: 'Healthcare', industry: 'Pharmaceuticals' }, // ABBOTINDIA (Abbott India)
  'INE220G01021': { sector: 'Metals & Mining', industry: 'Stainless Steel' }, // JSL (Jindal Stainless)
  'INE481Y01014': { sector: 'Financial Services', industry: 'Reinsurance' }, // GICRE (General Insurance Corporation)
  'INE976G01028': { sector: 'Financial Services', industry: 'Private Sector Bank' }, // RBLBANK (RBL Bank)
  'INE376G01013': { sector: 'Healthcare', industry: 'Biotechnology' }, // BIOCON (Biocon)
  'INE169A01031': { sector: 'Chemicals', industry: 'Fertilizers & Agro Chemicals' }, // COROMANDEL (Coromandel International)
  'INE303R01014': { sector: 'Consumer Durables', industry: 'Gems & Jewellery' }, // KALYANKJIL (Kalyan Jewellers)
  'INE473A01011': { sector: 'Chemicals', industry: 'Industrial Gases' }, // LINDEINDIA (Linde India)
  'INE018E01016': { sector: 'Financial Services', industry: 'Credit Cards' }, // SBICARD (SBI Cards)
  'INE484J01027': { sector: 'Realty', industry: 'Real Estate' }, // GODREJPROP (Godrej Properties)
  'INE068V01023': { sector: 'Healthcare', industry: 'Pharmaceuticals' }, // GLAND (Gland Pharma)
  'INE040H01021': { sector: 'Capital Goods', industry: 'Wind Energy Equipment' }, // SUZLON (Suzlon Energy)
  'INE0CZ201020': { sector: 'Healthcare', industry: 'Contract Research & Manufacturing' }, // ANTHEM (Anthem Biosciences)
  'INE188A01015': { sector: 'Chemicals', industry: 'Fertilizers & Agro Chemicals' }, // FACT (Fertilizers & Chemicals Travancore)
  'INE00H001014': { sector: 'Consumer Services', industry: 'E-Commerce / Food Delivery' }, // SWIGGY (Swiggy Limited)
  'INE528G01035': { sector: 'Financial Services', industry: 'Private Sector Bank' }, // YESBANK (Yes Bank)
  'INE819V01029': { sector: 'Consumer Durables', industry: 'Security Systems' }, // CPPLUS (Aditya Infotech)
  'INE347G01014': { sector: 'Oil Gas & Consumable Fuels', industry: 'Refineries & Marketing' }, // PETRONET (Petronet LNG)
  'INE202B01038': { sector: 'Financial Services', industry: 'Housing Finance' }, // PIRAMALFIN (Piramal Finance)
  'INE466L01038': { sector: 'Financial Services', industry: 'Wealth Management' }, // 360ONE (360 One WAM)
  'INE509F01029': { sector: 'Healthcare', industry: 'Medical Devices' }, // CUPID (Cupid Limited)
  'INE259A01022': { sector: 'Fast Moving Consumer Goods', industry: 'Personal Care' }, // COLPAL (Colgate-Palmolive India)
  'INE417T01026': { sector: 'Financial Services', industry: 'Insurance Brokerage / Fintech' }, // POLICYBZR (PB Fintech)
  'INE628A01036': { sector: 'Chemicals', industry: 'Agrochemicals' }, // UPL (UPL Limited)
  'INE206F01022': { sector: 'Financial Services', industry: 'Non Banking Financial Company (NBFC)' }, // AIIL (Authum Investment & Infrastructure)
  'INE180A01020': { sector: 'Financial Services', industry: 'Insurance Holding Company' }, // MFSL (Max Financial Services)
  'INE159A01016': { sector: 'Healthcare', industry: 'Pharmaceuticals' }, // GLAXO (GlaxoSmithKline Pharmaceuticals)
  'INE208C01025': { sector: 'Oil Gas & Consumable Fuels', industry: 'Oil & Gas Logistics' }, // AEGISLOG (Aegis Logistics)
  'INE01EA01019': { sector: 'Consumer Services', industry: 'Retail' } // VMM (Vishal Mega Mart)
};

function loadDataset() {
  const stat = fs.statSync(DATA_PATH);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.data;
  const source = fs.readFileSync(DATA_PATH, 'utf8');
  const statsMatch = source.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*const STOCKS_DATA = /);
  const stocksMatch = source.match(/const STOCKS_DATA = (\[[\s\S]*\]);\s*$/);
  if (!statsMatch || !stocksMatch) throw new Error('Stock dataset format is invalid');
  const data = { stats: JSON.parse(statsMatch[1]), stocks: JSON.parse(stocksMatch[1]) };
  const seen = new Set();
  data.stocks = data.stocks.filter(stock => {
    const isin = String(stock.isin || '').trim().toUpperCase();
    if (!isin || seen.has(isin)) return false;
    seen.add(isin);
    stock.isin = isin;
    if (SECTOR_OVERRIDES[isin]) {
      stock.sector = SECTOR_OVERRIDES[isin].sector;
      stock.industry = SECTOR_OVERRIDES[isin].industry;
    } else if (!stock.sector || String(stock.sector).toUpperCase() === 'GENERAL') {
      stock.sector = 'Unclassified';
    }
    return true;
  });
  cached = { mtimeMs: stat.mtimeMs, size: stat.size, data };
  return data;
}

const aliases = {
  zomato: 'ETERNAL', blinkit: 'ETERNAL', policybazaar: 'POLICYBZR',
  paisabazaar: 'POLICYBZR', maggi: 'NESTLEIND', jlr: 'TATAMOTORS', jaguar: 'TATAMOTORS'
};
const sortable = new Set(['rank', 'symbol', 'current_price', 'change_percent', 'market_cap_cr', 'return_1w', 'return_1m', 'return_3m', 'volume_ratio', 'volume']);

function searchMatches(stock, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const norm = q.replace(/[^a-z0-9]/g, '');
  const alias = aliases[q] || aliases[norm];
  if (alias && (stock.symbol === alias || stock.nse_symbol === alias)) return true;
  return ['symbol', 'company_name', 'nse_symbol', 'bse_scrip_code', 'isin', 'sector', 'industry']
    .some(key => String(stock[key] || '').toLowerCase().includes(q)) || (norm.length >= 2 &&
      ['symbol', 'company_name', 'nse_symbol'].some(key => String(stock[key] || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(norm)));
}

function queryStocks(params = {}) {
  const { stocks, stats } = loadDataset();
  const limit = Math.min(50, Math.max(1, Number.parseInt(params.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(params.offset, 10) || 0);
  const search = String(params.search || '').slice(0, 120);
  const filter = String(params.filter || 'ALL').toUpperCase();
  const exchange = String(params.exchange || '').toUpperCase();
  const sort = sortable.has(params.sort) ? params.sort : 'market_cap_cr';
  const direction = String(params.direction || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  let results = stocks.filter(s => {
    if (!searchMatches(s, search)) return false;
    if (exchange && !(Array.isArray(s.exchanges) && s.exchanges.includes(exchange))) return false;
    if (filter === 'TOP GAINERS' && !(Number(s.change_percent) > 0 || (s.prev_close != null && Number(s.current_price) > Number(s.prev_close)))) return false;
    if (filter === 'TOP LOSERS' && !(Number(s.change_percent) < 0 || (s.prev_close != null && Number(s.current_price) < Number(s.prev_close)))) return false;
    if (filter === 'NEAR 52W HIGH' && !(s.is_near_high || (s.pct_from_high && Number(s.pct_from_high) >= -8))) return false;
    return true;
  });
  const useCategoryOrder = (filter === 'TOP GAINERS' || filter === 'TOP LOSERS') && String(params.sortOverride).toLowerCase() !== 'true';
  if (!useCategoryOrder) {
    results.sort((a, b) => {
      const x = a[sort], y = b[sort];
      if (x == null && y != null) return 1;
      if (x != null && y == null) return -1;
      if (x == null && y == null) return String(a.isin).localeCompare(String(b.isin));
      const cmp = typeof x === 'string' ? String(x).localeCompare(String(y), undefined, { sensitivity: 'base' }) : Number(x) - Number(y);
      return (cmp || String(a.isin).localeCompare(String(b.isin))) * direction;
    });
  } else {
    results.sort((a, b) => (Number(a.change_percent || 0) - Number(b.change_percent || 0) || String(a.isin).localeCompare(String(b.isin))) * (filter === 'TOP GAINERS' ? -1 : 1));
  }
  return { ok: true, stocks: results.slice(offset, offset + limit), offset, nextOffset: Math.min(offset + limit, results.length), limit, total: results.length, hasMore: offset + limit < results.length, stats };
}

module.exports = { loadDataset, queryStocks };
