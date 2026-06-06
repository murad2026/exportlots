// ============================================
// EXPORTLOTS.COM — RATES CONFIG
// Update this file weekly with new carrier quotes
// Last updated: May 2026
// ============================================

const RATES = {

  // ---- INLAND (auction → port, per car) ----
  inland: {
    NJ: 200,   // Copart/Manheim NJ → Newark
    GA: 225,   // Copart/Manheim GA → Savannah
    TX: 250,   // Copart/Manheim TX → Houston
    CA: 300,   // Copart/Manheim CA → LA/LB
    FL: 220,   // Copart/Manheim FL → Miami/Jacksonville
  },

  // ---- PORT FEES (per container / 4 cars) ----
  portFees: {
    NJ: 800 / 4,   // $200/car
    GA: 500 / 4,   // $125/car
    TX: 500 / 4,   // $125/car
    CA: 800 / 4,   // $200/car
    FL: 500 / 4,   // $125/car
  },

  // ---- LOADING (4 cars in 40HC) ----
  loading: {
    NJ: 1115 / 4,  // $279/car
    GA: 1000 / 4,  // $250/car
    TX: 950  / 4,  // $238/car
    CA: 1400 / 4,  // $350/car
    FL: 950  / 4,  // $238/car
  },

  // ---- OCEAN FREIGHT (per container / 4 cars, from Newark) ----
  ocean: {
    Lagos:     3200 / 4,  // $800/car — Apapa, Nigeria
    Tema:      2558 / 4,  // $640/car — Ghana (real Hapag-Lloyd rate)
    JebelAli:  3800 / 4,  // $950/car — UAE
    Klaipeda:  2400 / 4,  // $600/car — Lithuania
    RioHaina:  2000 / 4,  // $500/car — Dominican Republic
    Poti:      1885 / 4,  // $471/car — Georgia (ONE carrier, eff. 05/16)
    Yerevan:   1885 / 4,  // $471/car ocean + $350 trucking Poti→Yerevan
  },

  // ---- TRUCKING (Poti → Yerevan, per car) ----
  trucking: {
    Yerevan: 350,
  },

  // ---- FIXED FEES (per car, every shipment) ----
  fixed: {
    ISF:   35,   // Importer Security Filing
    AES:   25,   // Automated Export System / EEI
    BL:    75,   // House Bill of Lading
    ECTN:  85,   // Electronic Cargo Tracking Note (Africa)
  },

  // ---- MARGIN ----
  margin: {
    retail: 450,  // Retail margin per car
    dealer: 200,  // Dealer margin per car (3+ cars/month)
  },

  // ---- BROKER FEE (buying assistance) ----
  brokerFee: {
    upTo5k:   250,
    upTo15k:  350,
    upTo30k:  450,
    above30k: 550,
  },

  // ---- AUCTION BUYER FEE ----
  auctionFee: [
    { max: 499,      fee: 25  },
    { max: 999,      fee: 50  },
    { max: 1499,     fee: 75  },
    { max: 1999,     fee: 100 },
    { max: 2499,     fee: 125 },
    { max: 2999,     fee: 150 },
    { max: 3999,     fee: 175 },
    { max: 4999,     fee: 200 },
    { max: 5999,     fee: 250 },
    { max: 6999,     fee: 275 },
    { max: 7999,     fee: 300 },
    { max: 9999,     fee: 325 },
    { max: 11999,    fee: 350 },
    { max: 14999,    fee: 375 },
    { max: 19999,    fee: 400 },
    { max: 24999,    fee: 450 },
    { max: 29999,    fee: 500 },
    { max: 34999,    fee: 550 },
    { max: Infinity, fee: 600 },
  ],

  // ---- TRANSACTION FEE (per lot) ----
  transactionFee: 110,
};

// ---- AUCTION FEE LOOKUP ----
function getAuctionFee(price) {
  for (const tier of RATES.auctionFee) {
    if (price <= tier.max) return tier.fee;
  }
  return 600;
}

// ---- BROKER FEE LOOKUP ----
function getBrokerFee(price) {
  if (price <= 5000)  return RATES.brokerFee.upTo5k;
  if (price <= 15000) return RATES.brokerFee.upTo15k;
  if (price <= 30000) return RATES.brokerFee.upTo30k;
  return RATES.brokerFee.above30k;
}

// ---- FULL ALL-IN PRICE CALCULATOR ----
// Returns breakdown + total for each destination
function calculateAllIn(lotPrice, destination, originPort = 'NJ', includeBroker = true) {
  const auctionFee     = getAuctionFee(lotPrice);
  const transactionFee = RATES.transactionFee;
  const brokerFee      = includeBroker ? getBrokerFee(lotPrice) : 0;
  const inland         = RATES.inland[originPort] || RATES.inland.NJ;
  const portFee        = RATES.portFees[originPort] || RATES.portFees.NJ;
  const loading        = RATES.loading[originPort] || RATES.loading.NJ;
  const ocean          = RATES.ocean[destination];
  const trucking       = destination === 'Yerevan' ? RATES.trucking.Yerevan : 0;
  const docs           = RATES.fixed.ISF + RATES.fixed.AES + RATES.fixed.BL +
                         (['Lagos','Tema'].includes(destination) ? RATES.fixed.ECTN : 0);
  const margin         = RATES.margin.retail;

  const total = lotPrice + auctionFee + transactionFee + brokerFee +
                inland + portFee + loading + ocean + trucking + docs + margin;

  return {
    breakdown: {
      'Lot price':        lotPrice,
      'Auction fee':      auctionFee,
      'Transaction fee':  transactionFee,
      'Broker assist':    brokerFee,
      'Inland transport': inland,
      'Port fee':         portFee,
      'Loading':          loading,
      'Ocean freight':    ocean,
      ...(trucking ? { 'Trucking Poti→Yerevan': trucking } : {}),
      'Docs (ISF/AES/BL)':docs,
      'Service fee':      margin,
    },
    total: Math.ceil(total / 50) * 50,
  };
}


function calculateDelivery(destination, originPort = 'NJ', cars = 4) {
  const inland  = RATES.inland[originPort] || RATES.inland.NJ;
  const port    = RATES.portFees[originPort] || RATES.portFees.NJ;
  const loading = RATES.loading[originPort] || RATES.loading.NJ;
  const ocean   = RATES.ocean[destination];
  const fixed   = RATES.fixed.ISF + RATES.fixed.AES + RATES.fixed.BL +
                  (destination === 'Lagos' || destination === 'Tema' ? RATES.fixed.ECTN : 0);

  const cost    = inland + port + loading + ocean + fixed;
  const retail  = Math.ceil((cost + RATES.margin.retail) / 50) * 50;
  const dealer  = Math.ceil((cost + RATES.margin.dealer) / 50) * 50;

  return { cost: Math.round(cost), retail, dealer };
}

// ---- DESTINATIONS ----
const DESTINATIONS = [
  { key: 'Lagos',    flag: '🇳🇬', label: 'Apapa, Lagos',   note: 'Nigeria' },
  { key: 'Tema',     flag: '🇬🇭', label: 'Tema, Ghana',    note: 'Ghana'   },
  { key: 'JebelAli', flag: '🇦🇪', label: 'Jebel Ali',      note: 'UAE — clean title only' },
  { key: 'Klaipeda', flag: '🇱🇹', label: 'Klaipeda',       note: 'Lithuania' },
  { key: 'RioHaina', flag: '🇩🇴', label: 'Rio Haina',      note: 'Dominican Republic' },
  { key: 'Poti',     flag: '🇬🇪', label: 'Poti',           note: 'Georgia' },
  { key: 'Yerevan',  flag: '🇦🇲', label: 'Yerevan',        note: 'Armenia via Poti' },
];

if (typeof module !== 'undefined') module.exports = { RATES, calculateDelivery, DESTINATIONS };
