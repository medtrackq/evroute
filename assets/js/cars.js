// EV models sold in Thailand. Approximate figures from manufacturer specs and owner reports:
// kwh = usable battery, use = real-world mixed driving (kWh/100 km), dc = peak DC charging (kW),
// ac = onboard AC charger (kW), plugs = DC inlets. The page lets the user override kWh and use.
(function (root) {
  'use strict';

  var CARS = [
    { id: 'byd-atto3-std', brand: 'BYD', model: 'Atto 3 Standard', kwh: 49.9, use: 16.5, dc: 70, ac: 7, plugs: ['CCS2'] },
    { id: 'byd-atto3-ext', brand: 'BYD', model: 'Atto 3 Extended', kwh: 60.5, use: 16.8, dc: 88, ac: 7, plugs: ['CCS2'] },
    { id: 'byd-dolphin-std', brand: 'BYD', model: 'Dolphin Standard', kwh: 44.9, use: 14.5, dc: 60, ac: 7, plugs: ['CCS2'] },
    { id: 'byd-dolphin-ext', brand: 'BYD', model: 'Dolphin Extended', kwh: 60.5, use: 15.0, dc: 80, ac: 7, plugs: ['CCS2'] },
    { id: 'byd-atto2', brand: 'BYD', model: 'Atto 2', kwh: 45.1, use: 15.0, dc: 65, ac: 7, plugs: ['CCS2'] },
    { id: 'byd-seal-dyn', brand: 'BYD', model: 'Seal Dynamic', kwh: 61.4, use: 15.5, dc: 110, ac: 7, plugs: ['CCS2'] },
    { id: 'byd-seal-prem', brand: 'BYD', model: 'Seal Premium / AWD', kwh: 82.5, use: 17.0, dc: 150, ac: 7, plugs: ['CCS2'] },
    { id: 'byd-sealion7', brand: 'BYD', model: 'Sealion 7', kwh: 82.5, use: 18.5, dc: 150, ac: 11, plugs: ['CCS2'] },
    { id: 'byd-m6', brand: 'BYD', model: 'M6', kwh: 71.8, use: 17.5, dc: 89, ac: 7, plugs: ['CCS2'] },
    { id: 'mg4-std', brand: 'MG', model: 'MG4 Electric (51 kWh)', kwh: 50.8, use: 16.0, dc: 88, ac: 6.6, plugs: ['CCS2'] },
    { id: 'mg4-lr', brand: 'MG', model: 'MG4 Electric (64 kWh)', kwh: 61.7, use: 16.5, dc: 135, ac: 11, plugs: ['CCS2'] },
    { id: 'mg-zs-ev', brand: 'MG', model: 'ZS EV', kwh: 49.0, use: 17.0, dc: 76, ac: 7, plugs: ['CCS2'] },
    { id: 'mg-ep', brand: 'MG', model: 'EP / EP Plus', kwh: 50.3, use: 17.0, dc: 50, ac: 6.6, plugs: ['CCS2'] },
    { id: 'mg-s5', brand: 'MG', model: 'S5 EV', kwh: 62.0, use: 17.0, dc: 140, ac: 11, plugs: ['CCS2'] },
    { id: 'ora-goodcat-400', brand: 'GWM ORA', model: 'Good Cat 400', kwh: 47.8, use: 15.5, dc: 64, ac: 6.6, plugs: ['CCS2'] },
    { id: 'ora-goodcat-500', brand: 'GWM ORA', model: 'Good Cat 500', kwh: 63.1, use: 16.0, dc: 64, ac: 6.6, plugs: ['CCS2'] },
    { id: 'ora-07', brand: 'GWM ORA', model: 'ORA 07', kwh: 83.5, use: 17.5, dc: 88, ac: 11, plugs: ['CCS2'] },
    { id: 'tesla-m3-rwd', brand: 'Tesla', model: 'Model 3 RWD', kwh: 57.5, use: 14.0, dc: 170, ac: 11, plugs: ['CCS2'] },
    { id: 'tesla-m3-lr', brand: 'Tesla', model: 'Model 3 Long Range', kwh: 75.0, use: 15.0, dc: 250, ac: 11, plugs: ['CCS2'] },
    { id: 'tesla-my-rwd', brand: 'Tesla', model: 'Model Y RWD', kwh: 57.5, use: 15.5, dc: 170, ac: 11, plugs: ['CCS2'] },
    { id: 'tesla-my-lr', brand: 'Tesla', model: 'Model Y Long Range', kwh: 75.0, use: 16.5, dc: 250, ac: 11, plugs: ['CCS2'] },
    { id: 'neta-v', brand: 'NETA', model: 'NETA V', kwh: 38.5, use: 14.5, dc: 50, ac: 6.6, plugs: ['CCS2'] },
    { id: 'neta-x', brand: 'NETA', model: 'NETA X', kwh: 60.0, use: 16.5, dc: 80, ac: 6.6, plugs: ['CCS2'] },
    { id: 'aion-y-plus', brand: 'AION', model: 'Y Plus', kwh: 61.7, use: 15.5, dc: 100, ac: 7, plugs: ['CCS2'] },
    { id: 'aion-v', brand: 'AION', model: 'V', kwh: 75.3, use: 17.0, dc: 180, ac: 11, plugs: ['CCS2'] },
    { id: 'deepal-s07', brand: 'Deepal', model: 'S07', kwh: 80.0, use: 18.5, dc: 93, ac: 6.6, plugs: ['CCS2'] },
    { id: 'deepal-l07', brand: 'Deepal', model: 'L07', kwh: 66.8, use: 16.5, dc: 93, ac: 6.6, plugs: ['CCS2'] },
    { id: 'zeekr-x', brand: 'ZEEKR', model: 'X', kwh: 64.0, use: 17.5, dc: 150, ac: 22, plugs: ['CCS2'] },
    { id: 'zeekr-7x', brand: 'ZEEKR', model: '7X', kwh: 100.0, use: 19.5, dc: 300, ac: 11, plugs: ['CCS2'] },
    { id: 'xpeng-g6', brand: 'XPENG', model: 'G6 Long Range', kwh: 87.5, use: 17.0, dc: 280, ac: 11, plugs: ['CCS2'] },
    { id: 'volvo-ex30', brand: 'Volvo', model: 'EX30', kwh: 64.0, use: 17.0, dc: 153, ac: 11, plugs: ['CCS2'] },
    { id: 'volvo-xc40', brand: 'Volvo', model: 'EX40 / XC40 Recharge', kwh: 79.0, use: 20.5, dc: 200, ac: 11, plugs: ['CCS2'] },
    { id: 'hyundai-ioniq5', brand: 'Hyundai', model: 'IONIQ 5 (77 kWh)', kwh: 74.0, use: 18.0, dc: 230, ac: 11, plugs: ['CCS2'] },
    { id: 'kia-ev6', brand: 'Kia', model: 'EV6 (77 kWh)', kwh: 74.0, use: 18.0, dc: 230, ac: 11, plugs: ['CCS2'] },
    { id: 'toyota-bz4x', brand: 'Toyota', model: 'bZ4X', kwh: 64.0, use: 18.0, dc: 150, ac: 6.6, plugs: ['CCS2'] },
    { id: 'bmw-ix1', brand: 'BMW', model: 'iX1 xDrive30', kwh: 64.7, use: 18.5, dc: 130, ac: 11, plugs: ['CCS2'] },
    { id: 'benz-eqa', brand: 'Mercedes-Benz', model: 'EQA 250', kwh: 66.5, use: 18.0, dc: 100, ac: 11, plugs: ['CCS2'] },
    { id: 'nissan-leaf', brand: 'Nissan', model: 'Leaf 40 kWh', kwh: 39.0, use: 16.0, dc: 46, ac: 6.6, plugs: ['CHAdeMO'] },
    { id: 'vinfast-vf5', brand: 'VinFast', model: 'VF 5', kwh: 37.2, use: 15.5, dc: 50, ac: 7.4, plugs: ['CCS2'] },
    { id: 'vinfast-vf6', brand: 'VinFast', model: 'VF 6', kwh: 59.6, use: 17.0, dc: 100, ac: 7.4, plugs: ['CCS2'] },
    { id: 'wuling-air', brand: 'Wuling', model: 'Air EV', kwh: 26.7, use: 12.0, dc: 0, ac: 6.6, plugs: [] },
    { id: 'custom', brand: 'อื่น ๆ', model: 'กำหนดเอง', kwh: 60, use: 17, dc: 80, ac: 7, plugs: ['CCS2'] },
  ];

  root.EVCars = CARS;
  if (typeof module === 'object' && module.exports) module.exports = CARS;
})(typeof window !== 'undefined' ? window : globalThis);
