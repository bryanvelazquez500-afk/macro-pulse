"""Equity Discovery: the largest listed companies per country, with live market snapshots.

The country lists are curated (no free source ranks listings by country and market cap): each
country's largest companies by market capitalization as of 2025–26 (tagged with a GICS-style sector), using the
listing our pipelines read best — the home exchange (ASML.AS) or the US listing for companies that
trade mainly there (Alibaba, Accenture). Each symbol was checked against Yahoo Finance when the list
was written. Prices, day changes and 52-week ranges are fetched live; the order isn't re-ranked live
because market capitalization isn't available from the free quote source.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from app.services.data_router import DataRouter, DataSource
from app.services.fmp_client import FmpClient
from app.services.quotes import QuoteService, Snapshot
from app.services.sec_client import SecApiError

# GICS-style sectors.
T, F, H, CD, CS, E, I, M, C, U, R = "Technology", "Financials", "Healthcare", "Consumer Discretionary", "Consumer Staples", "Energy", "Industrials", "Materials", "Communication Services", "Utilities", "Real Estate"
SECTORS = (T, F, H, CD, CS, C, I, E, M, U, R)  # display order

# ISO 3166-1 alpha-2 → [(symbol, company name, sector)]: the largest listed companies by market cap, grouped by sector.
LEADERS: dict[str, list[tuple[str, str, str]]] = {
 "US": [("AAPL","Apple",T),("MSFT","Microsoft",T),("NVDA","NVIDIA",T),("AVGO","Broadcom",T),("ORCL","Oracle",T),("AMD","Advanced Micro Devices",T),("CRM","Salesforce",T),("CSCO","Cisco",T),("IBM","IBM",T),("ADBE","Adobe",T),("QCOM","Qualcomm",T),("TXN","Texas Instruments",T),("INTU","Intuit",T),("NOW","ServiceNow",T),
        ("GOOGL","Alphabet",C),("META","Meta Platforms",C),("NFLX","Netflix",C),("TMUS","T-Mobile US",C),("DIS","Walt Disney",C),("VZ","Verizon",C),
        ("AMZN","Amazon",CD),("TSLA","Tesla",CD),("HD","Home Depot",CD),("MCD","McDonald's",CD),("BKNG","Booking Holdings",CD),("LOW","Lowe's",CD),
        ("BRK.B","Berkshire Hathaway",F),("JPM","JPMorgan Chase",F),("V","Visa",F),("MA","Mastercard",F),("BAC","Bank of America",F),("WFC","Wells Fargo",F),("GS","Goldman Sachs",F),("MS","Morgan Stanley",F),("AXP","American Express",F),
        ("LLY","Eli Lilly",H),("UNH","UnitedHealth",H),("JNJ","Johnson & Johnson",H),("ABBV","AbbVie",H),("MRK","Merck",H),("TMO","Thermo Fisher",H),("ABT","Abbott",H),("ISRG","Intuitive Surgical",H),
        ("WMT","Walmart",CS),("COST","Costco",CS),("PG","Procter & Gamble",CS),("KO","Coca-Cola",CS),("PEP","PepsiCo",CS),("PM","Philip Morris",CS),
        ("XOM","Exxon Mobil",E),("CVX","Chevron",E),("COP","ConocoPhillips",E),
        ("GE","GE Aerospace",I),("CAT","Caterpillar",I),("RTX","RTX",I),("HON","Honeywell",I),("UNP","Union Pacific",I),("BA","Boeing",I),
        ("LIN","Linde",M),("SHW","Sherwin-Williams",M),
        ("NEE","NextEra Energy",U),("SO","Southern Co",U),("DUK","Duke Energy",U),
        ("PLD","Prologis",R),("AMT","American Tower",R)],
 "CA": [("RY.TO","Royal Bank of Canada",F),("TD.TO","Toronto-Dominion Bank",F),("BN.TO","Brookfield Corp",F),("BMO.TO","Bank of Montreal",F),("BNS.TO","Bank of Nova Scotia",F),("CM.TO","CIBC",F),("MFC.TO","Manulife",F),
        ("SHOP.TO","Shopify",T),("CSU.TO","Constellation Software",T),("ENB.TO","Enbridge",E),("CNQ.TO","Canadian Natural Resources",E),("SU.TO","Suncor",E),
        ("CP.TO","Canadian Pacific Kansas City",I),("CNR.TO","Canadian National Railway",I),("TRI.TO","Thomson Reuters",I),("WCN.TO","Waste Connections",I),
        ("AEM.TO","Agnico Eagle",M),("ABX.TO","Barrick",M),("NTR.TO","Nutrien",M),("ATD.TO","Alimentation Couche-Tard",CS),("L.TO","Loblaw",CS),("FTS.TO","Fortis",U),("BCE.TO","BCE",C)],
 "MX": [("WALMEX.MX","Walmart de México",CS),("FEMSAUBD.MX","FEMSA",CS),("BIMBOA.MX","Grupo Bimbo",CS),("KOFUBL.MX","Coca-Cola FEMSA",CS),("AC.MX","Arca Continental",CS),
        ("AMXB.MX","América Móvil",C),("GFNORTEO.MX","Grupo Financiero Banorte",F),("GMEXICOB.MX","Grupo México",M),("CEMEXCPO.MX","Cemex",M),("GAPB.MX","Grupo Aeroportuario del Pacífico",I),("ASURB.MX","Grupo Aeroportuario del Sureste",I),("OMAB.MX","OMA",I)],
 "BR": [("PETR4.SA","Petrobras",E),("PRIO3.SA","PRIO",E),("ITUB4.SA","Itaú Unibanco",F),("BBDC4.SA","Bradesco",F),("BBAS3.SA","Banco do Brasil",F),("B3SA3.SA","B3",F),("ITSA4.SA","Itaúsa",F),
        ("VALE3.SA","Vale",M),("SUZB3.SA","Suzano",M),("ABEV3.SA","Ambev",CS),("RADL3.SA","Raia Drogasil",CS),("WEGE3.SA","WEG",I),("EMBJ3.SA","Embraer",I),("RDOR3.SA","Rede D'Or",H),
        ("AXIA3.SA","AXIA Energia (Eletrobras)",U),("SBSP3.SA","Sabesp",U),("EQTL3.SA","Equatorial",U),("VIVT3.SA","Telefônica Brasil",C),("LREN3.SA","Lojas Renner",CD)],
 "GB": [("AZN.L","AstraZeneca",H),("GSK.L","GSK",H),("SHEL.L","Shell",E),("BP.L","BP",E),("HSBA.L","HSBC",F),("LSEG.L","London Stock Exchange Group",F),("BARC.L","Barclays",F),("LLOY.L","Lloyds Banking Group",F),("NWG.L","NatWest",F),("PRU.L","Prudential",F),
        ("ULVR.L","Unilever",CS),("BATS.L","British American Tobacco",CS),("DGE.L","Diageo",CS),("TSCO.L","Tesco",CS),("HLN.L","Haleon",CS),
        ("RIO.L","Rio Tinto",M),("GLEN.L","Glencore",M),("AAL.L","Anglo American",M),("REL.L","RELX",I),("RR.L","Rolls-Royce",I),("BA.L","BAE Systems",I),("EXPN.L","Experian",I),
        ("CPG.L","Compass Group",CD),("NG.L","National Grid",U),("SSE.L","SSE",U),("VOD.L","Vodafone",C)],
 "FR": [("MC.PA","LVMH",CD),("RMS.PA","Hermès",CD),("KER.PA","Kering",CD),("OR.PA","L'Oréal",CS),("BN.PA","Danone",CS),("RI.PA","Pernod Ricard",CS),("TTE.PA","TotalEnergies",E),
        ("SAN.PA","Sanofi",H),("EL.PA","EssilorLuxottica",H),("AIR.PA","Airbus",I),("SU.PA","Schneider Electric",I),("SAF.PA","Safran",I),("DG.PA","Vinci",I),("HO.PA","Thales",I),("SGO.PA","Saint-Gobain",I),
        ("AI.PA","Air Liquide",M),("BNP.PA","BNP Paribas",F),("CS.PA","AXA",F),("ACA.PA","Crédit Agricole",F),("ENGI.PA","Engie",U),("ORA.PA","Orange",C),("CAP.PA","Capgemini",T),("DSY.PA","Dassault Systèmes",T)],
 "DE": [("SAP.DE","SAP",T),("IFX.DE","Infineon",T),("SIE.DE","Siemens",I),("RHM.DE","Rheinmetall",I),("ENR.DE","Siemens Energy",I),("DHL.DE","DHL Group",I),("MTX.DE","MTU Aero Engines",I),
        ("ALV.DE","Allianz",F),("MUV2.DE","Munich Re",F),("DB1.DE","Deutsche Börse",F),("DBK.DE","Deutsche Bank",F),("HNR1.DE","Hannover Re",F),("CBK.DE","Commerzbank",F),
        ("DTE.DE","Deutsche Telekom",C),("MBG.DE","Mercedes-Benz",CD),("BMW.DE","BMW",CD),("VOW3.DE","Volkswagen",CD),("ADS.DE","Adidas",CD),
        ("BAS.DE","BASF",M),("BAYN.DE","Bayer",H),("MRK.DE","Merck KGaA",H),("SHL.DE","Siemens Healthineers",H),("EOAN.DE","E.ON",U),("RWE.DE","RWE",U),("VNA.DE","Vonovia",R)],
 "NL": [("ASML.AS","ASML",T),("ASM.AS","ASM International",T),("BESI.AS","BE Semiconductor",T),("PRX.AS","Prosus",CD),("INGA.AS","ING",F),("ADYEN.AS","Adyen",F),("ABN.AS","ABN AMRO",F),("NN.AS","NN Group",F),("EXO.AS","Exor",F),
        ("HEIA.AS","Heineken",CS),("AD.AS","Ahold Delhaize",CS),("WKL.AS","Wolters Kluwer",I),("IMCD.AS","IMCD",I),("RAND.AS","Randstad",I),("PHIA.AS","Philips",H),("AKZA.AS","Akzo Nobel",M),("KPN.AS","KPN",C),("UMG.AS","Universal Music Group",C)],
 "CH": [("NESN.SW","Nestlé",CS),("RO.SW","Roche",H),("NOVN.SW","Novartis",H),("LONN.SW","Lonza",H),("ALC.SW","Alcon",H),("UBSG.SW","UBS",F),("ZURN.SW","Zurich Insurance",F),("PGHN.SW","Partners Group",F),("SREN.SW","Swiss Re",F),("SLHN.SW","Swiss Life",F),
        ("CFR.SW","Richemont",CD),("UHR.SW","Swatch Group",CD),("ABBN.SW","ABB",I),("KNIN.SW","Kuehne + Nagel",I),("GEBN.SW","Geberit",I),("HOLN.SW","Holcim",M),("SIKA.SW","Sika",M),("GIVN.SW","Givaudan",M),("SCMN.SW","Swisscom",C),("LOGN.SW","Logitech",T)],
 "ES": [("ITX.MC","Inditex",CD),("SAN.MC","Banco Santander",F),("BBVA.MC","BBVA",F),("CABK.MC","CaixaBank",F),("SAB.MC","Banco Sabadell",F),("BKT.MC","Bankinter",F),
        ("IBE.MC","Iberdrola",U),("ELE.MC","Endesa",U),("NTGY.MC","Naturgy",U),("TEF.MC","Telefónica",C),("CLNX.MC","Cellnex",C),("AMS.MC","Amadeus",T),
        ("FER.MC","Ferrovial",I),("AENA.MC","Aena",I),("IAG.MC","IAG",I),("ACS.MC","ACS",I),("REP.MC","Repsol",E),("GRF.MC","Grifols",H)],
 "IT": [("RACE.MI","Ferrari",CD),("STLAM.MI","Stellantis",CD),("MONC.MI","Moncler",CD),("ISP.MI","Intesa Sanpaolo",F),("UCG.MI","UniCredit",F),("G.MI","Generali",F),("MB.MI","Mediobanca",F),("PST.MI","Poste Italiane",F),("BAMI.MI","Banco BPM",F),
        ("ENEL.MI","Enel",U),("TRN.MI","Terna",U),("SRG.MI","Snam",U),("ENI.MI","Eni",E),("TEN.MI","Tenaris",E),("LDO.MI","Leonardo",I),("PRY.MI","Prysmian",I)],
 "SE": [("ATCO-A.ST","Atlas Copco",I),("VOLV-B.ST","Volvo",I),("ASSA-B.ST","Assa Abloy",I),("SAND.ST","Sandvik",I),("EPI-A.ST","Epiroc",I),("SAAB-B.ST","Saab",I),("ALFA.ST","Alfa Laval",I),
        ("INVE-B.ST","Investor AB",F),("SEB-A.ST","SEB",F),("SHB-A.ST","Handelsbanken",F),("SWED-A.ST","Swedbank",F),("ERIC-B.ST","Ericsson",T),("HEXA-B.ST","Hexagon",T),("HM-B.ST","H&M",CD),("EVO.ST","Evolution",CD),("ESSITY-B.ST","Essity",CS),("TELIA.ST","Telia",C)],
 "DK": [("NOVO-B.CO","Novo Nordisk",H),("COLO-B.CO","Coloplast",H),("GMAB.CO","Genmab",H),("DEMANT.CO","Demant",H),("DSV.CO","DSV",I),("MAERSK-B.CO","A.P. Møller-Mærsk",I),("VWS.CO","Vestas",I),
        ("NSIS-B.CO","Novonesis",M),("ORSTED.CO","Ørsted",U),("DANSKE.CO","Danske Bank",F),("TRYG.CO","Tryg",F),("CARL-B.CO","Carlsberg",CS),("PNDORA.CO","Pandora",CD)],
 "NO": [("EQNR.OL","Equinor",E),("AKRBP.OL","Aker BP",E),("DNB.OL","DNB",F),("GJF.OL","Gjensidige",F),("STB.OL","Storebrand",F),("KOG.OL","Kongsberg",I),("TEL.OL","Telenor",C),
        ("NHY.OL","Norsk Hydro",M),("YAR.OL","Yara",M),("MOWI.OL","Mowi",CS),("ORK.OL","Orkla",CS),("SALM.OL","SalMar",CS)],
 "FI": [("NDA-FI.HE","Nordea",F),("SAMPO.HE","Sampo",F),("NOKIA.HE","Nokia",T),("KNEBV.HE","Kone",I),("WRT1V.HE","Wärtsilä",I),("UPM.HE","UPM",M),("STERV.HE","Stora Enso",M),
        ("NESTE.HE","Neste",E),("FORTUM.HE","Fortum",U),("ELISA.HE","Elisa",C),("KESKOB.HE","Kesko",CS),("ORNBV.HE","Orion",H)],
 "BE": [("ABI.BR","AB InBev",CS),("ARGX.BR","argenx",H),("UCB.BR","UCB",H),("KBC.BR","KBC",F),("AGS.BR","Ageas",F),("GBLB.BR","GBL",F),("SOLB.BR","Solvay",M),("SYENS.BR","Syensqo",M),
        ("ELI.BR","Elia",U),("ACKB.BR","Ackermans & van Haaren",I),("PROX.BR","Proximus",C),("WDP.BR","WDP",R)],
 "IE": [("ACN","Accenture",T),("STX","Seagate",T),("MDT","Medtronic",H),("STE","Steris",H),("ETN","Eaton",I),("TT","Trane Technologies",I),("JCI","Johnson Controls",I),("RYA.IR","Ryanair",I),("KRX.IR","Kingspan",I),
        ("CRH","CRH",M),("FLUT","Flutter Entertainment",CD),("KRZ.IR","Kerry Group",CS),("GL9.IR","Glanbia",CS),("A5G.IR","AIB Group",F),("BIRG.IR","Bank of Ireland",F)],
 "PT": [("EDP.LS","EDP",U),("EDPR.LS","EDP Renováveis",U),("RENE.LS","REN",U),("GALP.LS","Galp Energia",E),("JMT.LS","Jerónimo Martins",CS),("SON.LS","Sonae",CS),("BCP.LS","Millennium BCP",F),
        ("NOS.LS","NOS",C),("NVG.LS","Navigator",M),("CTT.LS","CTT",I)],
 "AT": [("EBS.VI","Erste Group",F),("RBI.VI","Raiffeisen Bank International",F),("BG.VI","BAWAG",F),("OMV.VI","OMV",E),("VER.VI","Verbund",U),("ANDR.VI","Andritz",I),("POST.VI","Österreichische Post",I),
        ("VOE.VI","voestalpine",M),("WIE.VI","Wienerberger",M),("CAI.VI","CA Immobilien",R)],
 "JP": [("7203.T","Toyota",CD),("6758.T","Sony",CD),("9983.T","Fast Retailing",CD),("7267.T","Honda",CD),("6902.T","Denso",CD),
        ("8306.T","Mitsubishi UFJ",F),("8316.T","Sumitomo Mitsui",F),("8411.T","Mizuho",F),("8766.T","Tokio Marine",F),
        ("6501.T","Hitachi",I),("8058.T","Mitsubishi Corp",I),("8001.T","Itochu",I),("8031.T","Mitsui & Co",I),("6098.T","Recruit",I),("7011.T","Mitsubishi Heavy",I),("6367.T","Daikin",I),("6503.T","Mitsubishi Electric",I),
        ("8035.T","Tokyo Electron",T),("6861.T","Keyence",T),("6981.T","Murata",T),("6702.T","Fujitsu",T),
        ("9984.T","SoftBank Group",C),("9432.T","NTT",C),("9433.T","KDDI",C),("7974.T","Nintendo",C),
        ("4568.T","Daiichi Sankyo",H),("4502.T","Takeda",H),("4519.T","Chugai",H),("4063.T","Shin-Etsu Chemical",M),("2914.T","Japan Tobacco",CS)],
 "CN": [("0700.HK","Tencent",C),("0941.HK","China Mobile",C),("9999.HK","NetEase",C),("BIDU","Baidu",C),
        ("BABA","Alibaba",CD),("PDD","PDD Holdings",CD),("3690.HK","Meituan",CD),("1211.HK","BYD",CD),("9618.HK","JD.com",CD),
        ("1398.HK","ICBC",F),("0939.HK","China Construction Bank",F),("1288.HK","Agricultural Bank of China",F),("3988.HK","Bank of China",F),("2318.HK","Ping An",F),("600036.SS","China Merchants Bank",F),
        ("600519.SS","Kweichow Moutai",CS),("000858.SZ","Wuliangye",CS),("300750.SZ","CATL",I),("1810.HK","Xiaomi",T),
        ("0857.HK","PetroChina",E),("0883.HK","CNOOC",E),("1088.HK","China Shenhua",E),("600900.SS","China Yangtze Power",U),("601899.SS","Zijin Mining",M)],
 "HK": [("1299.HK","AIA Group",F),("0388.HK","Hong Kong Exchanges",F),("2388.HK","BOC Hong Kong",F),("0001.HK","CK Hutchison",I),("0066.HK","MTR",I),("0669.HK","Techtronic Industries",I),
        ("0016.HK","Sun Hung Kai Properties",R),("1113.HK","CK Asset",R),("0823.HK","Link REIT",R),("0012.HK","Henderson Land",R),
        ("0002.HK","CLP Holdings",U),("0003.HK","Hong Kong & China Gas",U),("0006.HK","Power Assets",U),("0027.HK","Galaxy Entertainment",CD)],
 "TW": [("2330.TW","TSMC",T),("2317.TW","Hon Hai (Foxconn)",T),("2454.TW","MediaTek",T),("2308.TW","Delta Electronics",T),("2382.TW","Quanta Computer",T),("3711.TW","ASE Technology",T),("2303.TW","UMC",T),("2345.TW","Accton",T),("3231.TW","Wistron",T),("2357.TW","Asustek",T),
        ("2881.TW","Fubon Financial",F),("2882.TW","Cathay Financial",F),("2891.TW","CTBC Financial",F),("2886.TW","Mega Financial",F),
        ("2412.TW","Chunghwa Telecom",C),("1301.TW","Formosa Plastics",M),("2002.TW","China Steel",M),("1216.TW","Uni-President",CS)],
 "KR": [("005930.KS","Samsung Electronics",T),("000660.KS","SK hynix",T),("006400.KS","Samsung SDI",T),
        ("373220.KS","LG Energy Solution",I),("012450.KS","Hanwha Aerospace",I),("028260.KS","Samsung C&T",I),
        ("207940.KS","Samsung Biologics",H),("068270.KS","Celltrion",H),("005380.KS","Hyundai Motor",CD),("000270.KS","Kia",CD),("012330.KS","Hyundai Mobis",CD),
        ("105560.KS","KB Financial",F),("055550.KS","Shinhan Financial",F),("032830.KS","Samsung Life",F),
        ("035420.KS","NAVER",C),("035720.KS","Kakao",C),("017670.KS","SK Telecom",C),("005490.KS","POSCO Holdings",M),("051910.KS","LG Chem",M),("015760.KS","KEPCO",U)],
 "IN": [("RELIANCE.NS","Reliance Industries",E),("ONGC.NS","ONGC",E),("COALINDIA.NS","Coal India",E),
        ("HDFCBANK.NS","HDFC Bank",F),("ICICIBANK.NS","ICICI Bank",F),("SBIN.NS","State Bank of India",F),("BAJFINANCE.NS","Bajaj Finance",F),("KOTAKBANK.NS","Kotak Mahindra Bank",F),("AXISBANK.NS","Axis Bank",F),
        ("TCS.NS","Tata Consultancy Services",T),("INFY.NS","Infosys",T),("HCLTECH.NS","HCLTech",T),("WIPRO.NS","Wipro",T),
        ("BHARTIARTL.NS","Bharti Airtel",C),("HINDUNILVR.NS","Hindustan Unilever",CS),("ITC.NS","ITC",CS),("NESTLEIND.NS","Nestlé India",CS),
        ("LT.NS","Larsen & Toubro",I),("ADANIENT.NS","Adani Enterprises",I),("SUNPHARMA.NS","Sun Pharma",H),("MARUTI.NS","Maruti Suzuki",CD),("M&M.NS","Mahindra & Mahindra",CD),("TITAN.NS","Titan",CD),
        ("NTPC.NS","NTPC",U),("POWERGRID.NS","Power Grid",U),("ULTRACEMCO.NS","UltraTech Cement",M),("ASIANPAINT.NS","Asian Paints",M),("TATASTEEL.NS","Tata Steel",M)],
 "AU": [("CBA.AX","Commonwealth Bank",F),("NAB.AX","National Australia Bank",F),("WBC.AX","Westpac",F),("ANZ.AX","ANZ",F),("MQG.AX","Macquarie",F),("QBE.AX","QBE",F),("SUN.AX","Suncorp",F),
        ("BHP.AX","BHP",M),("RIO.AX","Rio Tinto",M),("FMG.AX","Fortescue",M),("NST.AX","Northern Star",M),("CSL.AX","CSL",H),("RMD.AX","ResMed",H),
        ("WES.AX","Wesfarmers",CD),("ALL.AX","Aristocrat Leisure",CD),("WOW.AX","Woolworths",CS),("COL.AX","Coles",CS),("GMG.AX","Goodman Group",R),("WDS.AX","Woodside",E),
        ("TLS.AX","Telstra",C),("REA.AX","REA Group",C),("TCL.AX","Transurban",I),("XRO.AX","Xero",T),("WTC.AX","WiseTech Global",T)],
 "NZ": [("FPH.NZ","Fisher & Paykel Healthcare",H),("EBO.NZ","EBOS Group",H),("IFT.NZ","Infratil",U),("MEL.NZ","Meridian Energy",U),("CEN.NZ","Contact Energy",U),
        ("AIA.NZ","Auckland Airport",I),("MFT.NZ","Mainfreight",I),("SPK.NZ","Spark NZ",C),("FBU.NZ","Fletcher Building",M),("ATM.NZ","a2 Milk",CS)],
 "SG": [("D05.SI","DBS",F),("O39.SI","OCBC",F),("U11.SI","UOB",F),("S68.SI","SGX",F),("Z74.SI","Singtel",C),("C6L.SI","Singapore Airlines",I),("S63.SI","ST Engineering",I),("BN4.SI","Keppel",I),
        ("C38U.SI","CapitaLand Integrated Commercial Trust",R),("A17U.SI","CapitaLand Ascendas REIT",R),("9CI.SI","CapitaLand Investment",R),("F34.SI","Wilmar",CS),("Y92.SI","Thai Beverage",CS),("G13.SI","Genting Singapore",CD),("U96.SI","Sembcorp",U)],
 "IL": [("TEVA.TA","Teva Pharmaceutical",H),("LUMI.TA","Bank Leumi",F),("POLI.TA","Bank Hapoalim",F),("DSCT.TA","Israel Discount Bank",F),("MZTF.TA","Mizrahi Tefahot",F),
        ("ESLT.TA","Elbit Systems",I),("NICE.TA","NICE",T),("CHKP","Check Point Software",T),("MNDY","monday.com",T),("WIX","Wix.com",T),("ICL.TA","ICL Group",M),("BEZQ.TA","Bezeq",C),("AZRG.TA","Azrieli",R)],
 "ZA": [("NPN.JO","Naspers",CD),("FSR.JO","FirstRand",F),("SBK.JO","Standard Bank",F),("CPI.JO","Capitec",F),("ABG.JO","Absa",F),("NED.JO","Nedbank",F),("SLM.JO","Sanlam",F),("DSY.JO","Discovery",F),("REM.JO","Remgro",F),
        ("MTN.JO","MTN Group",C),("VOD.JO","Vodacom",C),("GFI.JO","Gold Fields",M),("ANG.JO","AngloGold Ashanti",M),("AGL.JO","Anglo American",M),("SOL.JO","Sasol",M),("SHP.JO","Shoprite",CS),("BID.JO","Bid Corporation",CS),("CLS.JO","Clicks Group",CS)],
 "SA": [("2222.SR","Saudi Aramco",E),("1120.SR","Al Rajhi Bank",F),("1180.SR","Saudi National Bank",F),("1150.SR","Alinma Bank",F),("1010.SR","Riyad Bank",F),("1060.SR","Saudi Awwal Bank",F),
        ("2010.SR","SABIC",M),("1211.SR","Ma'aden",M),("7010.SR","STC",C),("2082.SR","ACWA Power",U),("5110.SR","Saudi Electricity",U),("2280.SR","Almarai",CS),("4013.SR","Dr. Sulaiman Al Habib",H),("7203.SR","Elm",T)],
}


LIST_AS_OF = "2025–26"


@dataclass(frozen=True)
class Leader:
    rank: int
    symbol: str
    name: str
    sector: str
    snapshot: Snapshot | None
    coverage: str  # "sec" (free, full statements) | "fmp" | "fmp_key_required" | "unavailable"


async def _coverage(router: DataRouter, fmp: FmpClient, symbol: str) -> str:
    try:
        route = await router.resolve(symbol)
    except SecApiError:
        return "unavailable"
    if route.source is DataSource.SEC:
        return "sec"
    return "fmp" if fmp.configured else "fmp_key_required"


async def country_leaders(iso2: str, quotes: QuoteService, router: DataRouter, fmp: FmpClient) -> list[Leader] | None:
    """None when the country has no curated list."""
    entries = LEADERS.get(iso2.upper())
    if entries is None:
        return None
    snapshots, coverage = await asyncio.gather(
        asyncio.gather(*(quotes.get_snapshot(s) for s, _, _ in entries)),
        asyncio.gather(*(_coverage(router, fmp, s) for s, _, _ in entries)),
    )
    return [
        Leader(i + 1, s, name, sector, snap, cov) for i, ((s, name, sector), snap, cov) in enumerate(zip(entries, snapshots, coverage))
    ]
