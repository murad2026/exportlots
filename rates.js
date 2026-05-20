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
  }
};

// ---- CALCULATOR FUNCTION ----
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
];

if (typeof module !== 'undefined') module.exports = { RATES, calculateDelivery, DESTINATIONS };
