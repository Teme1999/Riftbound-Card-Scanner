// Imported price snapshots are USD. ECB rates are quoted as currency units per
// 1 EUR, so USD source values convert through EUR before the display currency.
export const FALLBACK_EXCHANGE_RATE_DATE = '2026-05-08';

export const FALLBACK_ECB_EUR_RATES = {
  EUR: 1,
  USD: 1.1761,
  GBP: 0.8641,
  JPY: 184.37,
  CAD: 1.6063,
  AUD: 1.6259,
  CHF: 0.9156,
  SEK: 10.842,
  NOK: 10.8215,
  DKK: 7.4726,
  PLN: 4.2318,
  CZK: 24.304,
  CNY: 7.9989,
  HKD: 9.2067,
  SGD: 1.4911,
  NZD: 1.9735,
  KRW: 1725.08,
  INR: 111.1285,
  MXN: 20.2716,
  BRL: 5.7794,
  ZAR: 19.3109,
};

export const PRICE_CURRENCY_OPTIONS = [
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'USD', label: 'USD - US dollar' },
  { value: 'GBP', label: 'GBP - Pound sterling' },
  { value: 'JPY', label: 'JPY - Japanese yen' },
  { value: 'CAD', label: 'CAD - Canadian dollar' },
  { value: 'AUD', label: 'AUD - Australian dollar' },
  { value: 'CHF', label: 'CHF - Swiss franc' },
  { value: 'SEK', label: 'SEK - Swedish krona' },
  { value: 'NOK', label: 'NOK - Norwegian krone' },
  { value: 'DKK', label: 'DKK - Danish krone' },
  { value: 'PLN', label: 'PLN - Polish zloty' },
  { value: 'CZK', label: 'CZK - Czech koruna' },
  { value: 'CNY', label: 'CNY - Chinese yuan' },
  { value: 'HKD', label: 'HKD - Hong Kong dollar' },
  { value: 'SGD', label: 'SGD - Singapore dollar' },
  { value: 'NZD', label: 'NZD - New Zealand dollar' },
  { value: 'KRW', label: 'KRW - South Korean won' },
  { value: 'INR', label: 'INR - Indian rupee' },
  { value: 'MXN', label: 'MXN - Mexican peso' },
  { value: 'BRL', label: 'BRL - Brazilian real' },
  { value: 'ZAR', label: 'ZAR - South African rand' },
];

const SUPPORTED_PRICE_CURRENCIES = new Set(PRICE_CURRENCY_OPTIONS.map((option) => option.value));
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW']);

export function normalizePriceCurrency(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return SUPPORTED_PRICE_CURRENCIES.has(normalized) ? normalized : 'EUR';
}

export function normalizeExchangeRates(rates) {
  const normalized = { ...FALLBACK_ECB_EUR_RATES };

  if (typeof rates === 'number') {
    if (Number.isFinite(rates) && rates > 0) {
      normalized.USD = rates;
    }
    return normalized;
  }

  if (rates && typeof rates === 'object') {
    for (const [currency, value] of Object.entries(rates)) {
      const code = String(currency || '').trim().toUpperCase();
      if (!SUPPORTED_PRICE_CURRENCIES.has(code)) {
        continue;
      }
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        normalized[code] = parsed;
      }
    }
  }

  normalized.EUR = 1;
  return normalized;
}

export function convertUsdPrice(value, currency = 'EUR', exchangeRates = FALLBACK_ECB_EUR_RATES) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rates = normalizeExchangeRates(exchangeRates);
  const targetCurrency = normalizePriceCurrency(currency);
  const usdPerEur = rates.USD;
  const targetPerEur = rates[targetCurrency] || FALLBACK_ECB_EUR_RATES[targetCurrency] || 1;

  return (parsed / usdPerEur) * targetPerEur;
}

export function formatPrice(value, currency = 'EUR', exchangeRates = FALLBACK_ECB_EUR_RATES) {
  const normalizedCurrency = normalizePriceCurrency(currency);
  const converted = convertUsdPrice(value, normalizedCurrency, exchangeRates);

  if (!Number.isFinite(converted)) {
    return null;
  }

  const fractionDigits = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)
    ? 0
    : converted >= 10 ? 0 : 2;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: normalizedCurrency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(converted);
}

export function formatEurPrice(value) {
  return formatPrice(value, 'EUR');
}
