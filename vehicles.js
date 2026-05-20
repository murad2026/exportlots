// ============================================
// EXPORTLOTS.COM — VEHICLES DATABASE
// VA fills this daily from Manheim
// Format: one object per vehicle
// ============================================

const VEHICLES = [
  {
    id: "4T1B11HK3KU800400",
    vin: "4T1B11HK3KU800400",
    year: 2019,
    make: "Toyota",
    model: "Camry LE",
    mileage: 278231,
    engine: "2.5L 4-Cyl",
    transmission: "Auto",
    drive: "FWD",
    color: "Celestial Silver",
    grade: 2.4,
    mmr: 4550,
    titleStatus: "absent",      // clean / salvage / absent / rebuilt
    originPort: "TX",           // NJ / GA / TX / CA / FL
    auctionType: "buynow",      // buynow / auction
    auctionDate: null,          // null for buynow, "2026-05-25T14:00" for auction
    stockPhoto: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg/1280px-2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg",
    damage: [
      { zone: "windshield",       status: "damage",  desc: "Cracked" },
      { zone: "frontBumper",      status: "damage",  desc: "Broken" },
      { zone: "hood",             status: "damage",  desc: "Dents" },
      { zone: "leftFrontDoor",    status: "damage",  desc: "Dents" },
      { zone: "leftFender",       status: "damage",  desc: "Dents" },
      { zone: "leftFender",       status: "repair",  desc: "Previous repair" },
      { zone: "leftRearDoor",     status: "damage",  desc: "Dents x2" },
      { zone: "rightRearDoor",    status: "repair",  desc: "Previous repair" },
      { zone: "rightFrontDoor",   status: "damage",  desc: "Dents" },
      { zone: "rearBumper",       status: "damage",  desc: "Dents" },
    ],
    interiorWarnings: [
      "Engine warning light on",
      "Traction control warning on",
      "All seats worn/stained",
      "Headliner hole"
    ],
    owners: 3,
    accidents: 1,
    active: true,
  },

  // ---- ADD MORE VEHICLES BELOW ----
  // VA template:
  // {
  //   id: "VIN",
  //   vin: "VIN",
  //   year: YYYY,
  //   make: "Make",
  //   model: "Model Trim",
  //   mileage: 00000,
  //   engine: "X.XL X-Cyl",
  //   transmission: "Auto",
  //   drive: "FWD/RWD/AWD/4WD",
  //   color: "Color Name",
  //   grade: X.X,
  //   mmr: XXXXX,
  //   titleStatus: "clean/salvage/absent/rebuilt",
  //   originPort: "NJ/GA/TX/CA/FL",
  //   auctionType: "buynow/auction",
  //   auctionDate: null or "YYYY-MM-DDTHH:MM",
  //   stockPhoto: "URL to stock photo",
  //   damage: [ { zone: "...", status: "damage/repair/clean/unknown", desc: "..." } ],
  //   interiorWarnings: [],
  //   owners: X,
  //   accidents: X,
  //   active: true,
  // },
];

if (typeof module !== 'undefined') module.exports = { VEHICLES };
