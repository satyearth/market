'use strict';

const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const JS_DIR = path.join(ROOT_DIR, 'js');
const CACHE_DIR = path.join(ROOT_DIR, '.cache');
const REPORTS_DIR = path.join(ROOT_DIR, 'docs', 'reports');

const TARGET_DATA_PATH = path.join(JS_DIR, 'stocks-data.js');
const BACKUP_DATA_PATH = path.join(JS_DIR, 'stocks-data.backup.js');

const DEFAULT_BUCKET = 'machii-bazzar-datasets';
const LATEST_POINTER_PATH = 'latest.json';
const LOCK_OBJECT_PATH = 'locks/refresh.lock.json';
const REFERENCE_PREFIX = 'reference';
const HISTORY_PREFIX = 'history';
const DEFAULT_RETAIN_TRADING_SESSIONS = 90;
const DEFAULT_RETAIN_HISTORY_SESSIONS = 10;
const MAX_HISTORICAL_SESSIONS = 90;
const DOWNLOAD_WINDOW_SESSIONS = 6;
const CARRY_FORWARD_SESSIONS = 5;
const SPARKLINE_SESSIONS = 6;
const RETURN_WINDOW_1W_SESSIONS = 6;
const RETURN_WINDOW_1M_SESSIONS = 22;
const RETURN_WINDOW_3M_SESSIONS = 66;
const POINTER_CACHE_TTL_MS = 15 * 1000;

const NSE_ELIGIBLE_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST', 'SZ']);
const BSE_INCLUDED_GROUPS = new Set([
  'A', 'B', 'T', 'X', 'XT', 'M', 'MT', 'Z', 'ZP', 'P', 'R', 'SS', 'MS', 'TS', 'IF', 'IT', 'E'
]);
const BSE_EXCLUDED_GROUPS = new Set(['F', 'G', 'D', 'GC', 'C', 'W', 'H', 'Q']);

const REFERENCE_FILES = [
  'benchmark_stocks_verified.json',
  'bse_list_securities_verified.json',
  'screener_market_caps.json',
  'api-companies-catalog.json'
];

const SORTABLE_FIELDS = new Set([
  'symbol', 'current_price', 'change_percent', 'market_cap_cr',
  'pe_ratio', 'pb_ratio', 'volume', 'volume_ratio', 'pct_from_high', 'company_name'
]);

const SECTOR_OVERRIDES = {
  'INE0BJO01010': { sector: 'Telecommunication', industry: 'Telecom - Services' },
  'INE721I01024': { sector: 'Financial Services', industry: 'Capital Markets' },
  'INE931S01010': { sector: 'Power', industry: 'Power - Transmission' },
  'INE0V6F01027': { sector: 'Automobile and Auto Components', industry: 'Automobiles' },
  'INE323A01026': { sector: 'Automobile and Auto Components', industry: 'Auto Components' },
  'INE1TAE01010': { sector: 'Automobile and Auto Components', industry: 'Commercial Vehicles' },
  'INE1CDF01017': { sector: 'Metals & Mining', industry: 'Aluminium' },
  'INE976I01016': { sector: 'Financial Services', industry: 'Non Banking Financial Company (NBFC)' },
  'INE346A01027': { sector: 'Financial Services', industry: 'Asset Management' },
  'INE669E01016': { sector: 'Telecommunication', industry: 'Telecom - Cellular & Fixed line' },
  'INE0HOQ01053': { sector: 'Financial Services', industry: 'Stockbroking & Allied' },
  'INE07Y701011': { sector: 'Capital Goods', industry: 'Heavy Electrical Equipment' },
  'INE214T01019': { sector: 'Information Technology', industry: 'IT Services & Consulting' },
  'INE053A01029': { sector: 'Consumer Services', industry: 'Hotels & Resorts' },
  'INE956O01016': { sector: 'Consumer Services', industry: 'Specialty Retail' },
  'INE010B01027': { sector: 'Healthcare', industry: 'Pharmaceuticals' },
  'INE749A01030': { sector: 'Metals & Mining', industry: 'Iron & Steel' },
  'INE196A01026': { sector: 'Fast Moving Consumer Goods', industry: 'Edible Oil & Personal Care' },
  'INE118A01012': { sector: 'Financial Services', industry: 'Holding Company' },
  'INE562A01011': { sector: 'Financial Services', industry: 'Public Sector Bank' },
  'INE324D01010': { sector: 'Consumer Durables', industry: 'Consumer Electronics' },
  'INE670K01029': { sector: 'Realty', industry: 'Real Estate' },
  'INE982J01020': { sector: 'Financial Services', industry: 'Financial Technology (Fintech)' },
  'INE200A01026': { sector: 'Capital Goods', industry: 'Heavy Electrical Equipment' },
  'INE127D01025': { sector: 'Financial Services', industry: 'Asset Management' },
  'INE134E01011': { sector: 'Financial Services', industry: 'Financial Institution' },
  'INE1NPP01017': { sector: 'Capital Goods', industry: 'Heavy Electrical Equipment' },
  'INE634S01028': { sector: 'Healthcare', industry: 'Pharmaceuticals' },
  'INE0VDM01015': { sector: 'Consumer Services', industry: 'E-Commerce' },
  'INE854D01024': { sector: 'Fast Moving Consumer Goods', industry: 'Beverages' },
  'INE155A01022': { sector: 'Automobile and Auto Components', industry: 'Automobiles' },
  'INE121J01017': { sector: 'Telecommunication', industry: 'Telecom - Infrastructure' },
  'INE053F01010': { sector: 'Financial Services', industry: 'Financial Institution' },
  'INE388Y01029': { sector: 'Consumer Services', industry: 'E-Commerce' },
  'INE640G01020': { sector: 'Financial Services', industry: 'Asset Management' },
  'INE776C01039': { sector: 'Services', industry: 'Airport Operations' },
  'INE281B01032': { sector: 'Metals & Mining', industry: 'Iron & Steel' },
  'INE881D01027': { sector: 'Information Technology', industry: 'Enterprise Software' },
  'INE465A01025': { sector: 'Automobile and Auto Components', industry: 'Auto Components' },
  'INE459N01021': { sector: 'Healthcare', industry: 'Hospital & Healthcare Services' },
  'INE070A01015': { sector: 'Construction Materials', industry: 'Cement & Cement Products' },
  'INE343G01021': { sector: 'Telecommunication', industry: 'Telecom - Services' },
  'INE008A01015': { sector: 'Financial Services', industry: 'Private Sector Bank' },
  'INE880J01026': { sector: 'Services', industry: 'Port & Port Services' },
  'INE765G01017': { sector: 'Financial Services', industry: 'General Insurance' },
  'INE094A01015': { sector: 'Oil Gas & Consumable Fuels', industry: 'Refineries & Marketing' },
  'INE663F01032': { sector: 'Consumer Services', industry: 'Internet & Web Portals' },
  'INE020B01018': { sector: 'Financial Services', industry: 'Financial Institution' },
  'INE274J01014': { sector: 'Oil Gas & Consumable Fuels', industry: 'Oil Exploration & Production' },
  'INE249Z01020': { sector: 'Capital Goods', industry: 'Shipbuilding' },
  'INE0LEZ01016': { sector: 'Automobile and Auto Components', industry: 'Electric Vehicles' },
  'INE114A01011': { sector: 'Metals & Mining', industry: 'Iron & Steel' },
  'INE0ONG01011': { sector: 'Power', industry: 'Renewable Energy' },
  'INE377N01017': { sector: 'Capital Goods', industry: 'Solar Energy Equipment' },
  'INE405E01023': { sector: 'Automobile and Auto Components', industry: 'Auto Components' },
  'INE949L01017': { sector: 'Financial Services', industry: 'Small Finance Bank' },
  'INE377Y01014': { sector: 'Financial Services', industry: 'Housing Finance' },
  'INE372A01015': { sector: 'Capital Goods', industry: 'Electrical Cables & Wires' },
  'INE498L01015': { sector: 'Financial Services', industry: 'Non Banking Financial Company (NBFC)' },
  'INE298J01013': { sector: 'Financial Services', industry: 'Asset Management' },
  'INE191B01025': { sector: 'Metals & Mining', industry: 'Iron & Steel Products' },
  'INE399L01023': { sector: 'Oil Gas & Consumable Fuels', industry: 'City Gas Distribution' },
  'INE726G01019': { sector: 'Financial Services', industry: 'Life Insurance' },
  'INE457A01014': { sector: 'Financial Services', industry: 'Public Sector Bank' },
  'INE584A01023': { sector: 'Metals & Mining', industry: 'Minerals & Mining' },
  'INE084101034': { sector: 'Capital Goods', industry: 'Precision Engineering' },
  'INE084A01016': { sector: 'Financial Services', industry: 'Public Sector Bank' },
  'INE702C01027': { sector: 'Capital Goods', industry: 'Structural Steel Tubes' },
  'INE139A01034': { sector: 'Metals & Mining', industry: 'Aluminium' },
  'INE944F01028': { sector: 'Fast Moving Consumer Goods', industry: 'Distilleries & Wineries' },
  'INE565A01014': { sector: 'Financial Services', industry: 'Public Sector Bank' },
  'INE358A01014': { sector: 'Healthcare', industry: 'Pharmaceuticals' },
  'INE220G01021': { sector: 'Metals & Mining', industry: 'Stainless Steel' },
  'INE481Y01014': { sector: 'Financial Services', industry: 'Reinsurance' },
  'INE976G01028': { sector: 'Financial Services', industry: 'Private Sector Bank' },
  'INE376G01013': { sector: 'Healthcare', industry: 'Biotechnology' },
  'INE169A01031': { sector: 'Chemicals', industry: 'Fertilizers & Agro Chemicals' },
  'INE303R01014': { sector: 'Consumer Durables', industry: 'Gems & Jewellery' },
  'INE473A01011': { sector: 'Chemicals', industry: 'Industrial Gases' },
  'INE018E01016': { sector: 'Financial Services', industry: 'Credit Cards' },
  'INE484J01027': { sector: 'Realty', industry: 'Real Estate' },
  'INE068V01023': { sector: 'Healthcare', industry: 'Pharmaceuticals' },
  'INE040H01021': { sector: 'Capital Goods', industry: 'Wind Energy Equipment' },
  'INE0CZ201020': { sector: 'Healthcare', industry: 'Contract Research & Manufacturing' },
  'INE188A01015': { sector: 'Chemicals', industry: 'Fertilizers & Agro Chemicals' },
  'INE00H001014': { sector: 'Consumer Services', industry: 'E-Commerce / Food Delivery' },
  'INE528G01035': { sector: 'Financial Services', industry: 'Private Sector Bank' },
  'INE819V01029': { sector: 'Consumer Durables', industry: 'Security Systems' },
  'INE347G01014': { sector: 'Oil Gas & Consumable Fuels', industry: 'Refineries & Marketing' },
  'INE202B01038': { sector: 'Financial Services', industry: 'Housing Finance' },
  'INE466L01038': { sector: 'Financial Services', industry: 'Wealth Management' },
  'INE509F01029': { sector: 'Healthcare', industry: 'Medical Devices' },
  'INE259A01022': { sector: 'Fast Moving Consumer Goods', industry: 'Personal Care' },
  'INE417T01026': { sector: 'Financial Services', industry: 'Insurance Brokerage / Fintech' },
  'INE628A01036': { sector: 'Chemicals', industry: 'Agrochemicals' },
  'INE206F01022': { sector: 'Financial Services', industry: 'Non Banking Financial Company (NBFC)' },
  'INE180A01020': { sector: 'Financial Services', industry: 'Insurance Holding Company' },
  'INE159A01016': { sector: 'Healthcare', industry: 'Pharmaceuticals' },
  'INE208C01025': { sector: 'Oil Gas & Consumable Fuels', industry: 'Oil & Gas Logistics' },
  'INE01EA01019': { sector: 'Consumer Services', industry: 'Retail' }
};

module.exports = {
  ROOT_DIR,
  DOWNLOADS_DIR,
  JS_DIR,
  CACHE_DIR,
  REPORTS_DIR,
  TARGET_DATA_PATH,
  BACKUP_DATA_PATH,
  DEFAULT_BUCKET,
  LATEST_POINTER_PATH,
  LOCK_OBJECT_PATH,
  REFERENCE_PREFIX,
  HISTORY_PREFIX,
  DEFAULT_RETAIN_TRADING_SESSIONS,
  DEFAULT_RETAIN_HISTORY_SESSIONS,
  MAX_HISTORICAL_SESSIONS,
  DOWNLOAD_WINDOW_SESSIONS,
  CARRY_FORWARD_SESSIONS,
  SPARKLINE_SESSIONS,
  RETURN_WINDOW_1W_SESSIONS,
  RETURN_WINDOW_1M_SESSIONS,
  RETURN_WINDOW_3M_SESSIONS,
  POINTER_CACHE_TTL_MS,
  NSE_ELIGIBLE_SERIES,
  BSE_INCLUDED_GROUPS,
  BSE_EXCLUDED_GROUPS,
  REFERENCE_FILES,
  SORTABLE_FIELDS,
  SECTOR_OVERRIDES
};
