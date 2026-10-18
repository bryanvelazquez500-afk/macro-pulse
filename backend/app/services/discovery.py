"""Equity Discovery: the largest listed companies per country, with live market snapshots.

The country lists are curated (no free source groups listings by country): each country's largest
companies (tagged with a GICS-style sector), plus — for depth — every further large company whose
statements are publicly available through SEC EDGAR (US filers, and foreign companies filing 20-F/40-F).
Each uses the listing our pipelines read best: the home exchange (ASML.AS, 9988.HK) or the US listing
for companies that trade mainly there (Accenture, Spotify). Every symbol was checked against Yahoo
Finance and the data router when the list was written.

Prices, day changes and 52-week ranges are fetched live, and each list is ranked by live market cap
(see market_caps.py).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace

from app.services.data_router import DataRouter, DataSource
from app.services.fmp_client import FmpClient
from app.services.listings import SEC_REGISTRANT_FOR_LISTING, parse_listing
from app.services.market_caps import MarketCaps
from app.services.quotes import QuoteService, Snapshot
from app.services.sec_client import CompanyNotFoundError, SecApiError

# GICS-style sectors.
T, F, H, CD, CS, E, I, M, C, U, R = "Technology", "Financials", "Healthcare", "Consumer Discretionary", "Consumer Staples", "Energy", "Industrials", "Materials", "Communication Services", "Utilities", "Real Estate"
SECTORS = (T, F, H, CD, CS, C, I, E, M, U, R)  # display order

# ISO 3166-1 alpha-2 → [(symbol, company name, sector)]: the largest listed companies by market cap, grouped by sector.
LEADERS: dict[str, list[tuple[str, str, str]]] = {
 "US": [("AAPL","Apple",T),("MSFT","Microsoft",T),("NVDA","NVIDIA",T),("AVGO","Broadcom",T),("ORCL","Oracle",T),("AMD","Advanced Micro Devices",T),("CRM","Salesforce",T),("CSCO","Cisco",T),
        ("IBM","IBM",T),("ADBE","Adobe",T),("QCOM","Qualcomm",T),("TXN","Texas Instruments",T),("INTU","Intuit",T),("NOW","ServiceNow",T),("AMAT","Applied Materials",T),("MU","Micron Technology",T),
        ("LRCX","Lam Research",T),("KLAC","KLA",T),("ADI","Analog Devices",T),("PANW","Palo Alto Networks",T),("ANET","Arista Networks",T),("CRWD","CrowdStrike",T),("SNPS","Synopsys",T),("CDNS","Cadence Design",T),
        ("INTC","Intel",T),("APH","Amphenol",T),("MSI","Motorola Solutions",T),("PLTR","Palantir",T),("DELL","Dell Technologies",T),("FTNT","Fortinet",T),("WDAY","Workday",T),("MRVL","Marvell Technology",T),
        ("ADSK","Autodesk",T),("ROP","Roper Technologies",T),("HPQ","HP Inc",T),("GLW","Corning",T),
        ("BRK.B","Berkshire Hathaway",F),("JPM","JPMorgan Chase",F),("V","Visa",F),("MA","Mastercard",F),("BAC","Bank of America",F),("WFC","Wells Fargo",F),("GS","Goldman Sachs",F),("MS","Morgan Stanley",F),
        ("AXP","American Express",F),("C","Citigroup",F),("SCHW","Charles Schwab",F),("BLK","BlackRock",F),("SPGI","S&P Global",F),("PGR","Progressive",F),("CB","Chubb",F),("BX","Blackstone",F),
        ("KKR","KKR",F),("ICE","Intercontinental Exchange",F),("CME","CME Group",F),("PNC","PNC Financial",F),("USB","U.S. Bancorp",F),("COF","Capital One",F),("AON","Aon",F),("MCO","Moody's",F),
        ("PYPL","PayPal",F),("MET","MetLife",F),("AIG","AIG",F),("TRV","Travelers",F),
        ("LLY","Eli Lilly",H),("UNH","UnitedHealth",H),("JNJ","Johnson & Johnson",H),("ABBV","AbbVie",H),("MRK","Merck",H),("TMO","Thermo Fisher",H),("ABT","Abbott",H),("ISRG","Intuitive Surgical",H),
        ("AMGN","Amgen",H),("PFE","Pfizer",H),("DHR","Danaher",H),("BSX","Boston Scientific",H),("SYK","Stryker",H),("GILD","Gilead",H),("VRTX","Vertex",H),("BMY","Bristol-Myers Squibb",H),
        ("CVS","CVS Health",H),("CI","Cigna",H),("ELV","Elevance Health",H),("ZTS","Zoetis",H),("REGN","Regeneron",H),("BDX","Becton Dickinson",H),("HCA","HCA Healthcare",H),("MCK","McKesson",H),
        ("COR","Cencora",H),
        ("AMZN","Amazon",CD),("TSLA","Tesla",CD),("HD","Home Depot",CD),("MCD","McDonald's",CD),("BKNG","Booking Holdings",CD),("LOW","Lowe's",CD),("TJX","TJX Companies",CD),("NKE","Nike",CD),
        ("SBUX","Starbucks",CD),("ABNB","Airbnb",CD),("CMG","Chipotle",CD),("ORLY","O'Reilly Automotive",CD),("AZO","AutoZone",CD),("MAR","Marriott",CD),("HLT","Hilton",CD),("GM","General Motors",CD),
        ("F","Ford",CD),("ROST","Ross Stores",CD),("RCL","Royal Caribbean",CD),("DASH","DoorDash",CD),("LULU","Lululemon",CD),("YUM","Yum! Brands",CD),("DHI","D.R. Horton",CD),("LEN","Lennar",CD),
        ("WMT","Walmart",CS),("COST","Costco",CS),("PG","Procter & Gamble",CS),("KO","Coca-Cola",CS),("PEP","PepsiCo",CS),("PM","Philip Morris",CS),("MO","Altria",CS),("MDLZ","Mondelez",CS),
        ("CL","Colgate-Palmolive",CS),("TGT","Target",CS),("KMB","Kimberly-Clark",CS),("KDP","Keurig Dr Pepper",CS),("KHC","Kraft Heinz",CS),("GIS","General Mills",CS),("STZ","Constellation Brands",CS),("HSY","Hershey",CS),
        ("KR","Kroger",CS),("SYY","Sysco",CS),("MNST","Monster Beverage",CS),("EL","Estée Lauder",CS),
        ("GOOGL","Alphabet",C),("META","Meta Platforms",C),("NFLX","Netflix",C),("TMUS","T-Mobile US",C),("DIS","Walt Disney",C),("VZ","Verizon",C),("T","AT&T",C),("CMCSA","Comcast",C),
        ("CHTR","Charter Communications",C),("TTWO","Take-Two Interactive",C),("WBD","Warner Bros. Discovery",C),("LYV","Live Nation",C),("OMC","Omnicom",C),("RBLX","Roblox",C),
        ("GE","GE Aerospace",I),("CAT","Caterpillar",I),("RTX","RTX",I),("HON","Honeywell",I),("UNP","Union Pacific",I),("BA","Boeing",I),("DE","Deere",I),("LMT","Lockheed Martin",I),
        ("UPS","UPS",I),("ADP","ADP",I),("WM","Waste Management",I),("GD","General Dynamics",I),("NOC","Northrop Grumman",I),("MMM","3M",I),("ITW","Illinois Tool Works",I),("CSX","CSX",I),
        ("NSC","Norfolk Southern",I),("FDX","FedEx",I),("EMR","Emerson",I),("PH","Parker-Hannifin",I),("TDG","TransDigm",I),("CTAS","Cintas",I),("GEV","GE Vernova",I),("PCAR","Paccar",I),
        ("URI","United Rentals",I),("CPRT","Copart",I),
        ("XOM","Exxon Mobil",E),("CVX","Chevron",E),("COP","ConocoPhillips",E),("EOG","EOG Resources",E),("SLB","SLB",E),("PSX","Phillips 66",E),("MPC","Marathon Petroleum",E),("VLO","Valero",E),
        ("OXY","Occidental",E),("WMB","Williams",E),("KMI","Kinder Morgan",E),("OKE","ONEOK",E),("FANG","Diamondback Energy",E),("HAL","Halliburton",E),("BKR","Baker Hughes",E),("DVN","Devon Energy",E),
        ("LNG","Cheniere Energy",E),
        ("LIN","Linde",M),("SHW","Sherwin-Williams",M),("APD","Air Products",M),("ECL","Ecolab",M),("FCX","Freeport-McMoRan",M),("NEM","Newmont",M),("DOW","Dow",M),("DD","DuPont",M),
        ("NUE","Nucor",M),("PPG","PPG Industries",M),("CTVA","Corteva",M),("VMC","Vulcan Materials",M),("MLM","Martin Marietta",M),("IFF","IFF",M),("LYB","LyondellBasell",M),("ALB","Albemarle",M),
        ("STLD","Steel Dynamics",M),
        ("NEE","NextEra Energy",U),("SO","Southern Co",U),("DUK","Duke Energy",U),("CEG","Constellation Energy",U),("AEP","American Electric Power",U),("D","Dominion Energy",U),("SRE","Sempra",U),("EXC","Exelon",U),
        ("XEL","Xcel Energy",U),("PCG","PG&E",U),("PEG","PSEG",U),("ED","Consolidated Edison",U),("VST","Vistra",U),("WEC","WEC Energy",U),("EIX","Edison International",U),("ETR","Entergy",U),
        ("PLD","Prologis",R),("AMT","American Tower",R),("EQIX","Equinix",R),("WELL","Welltower",R),("SPG","Simon Property",R),("O","Realty Income",R),("PSA","Public Storage",R),("CCI","Crown Castle",R),
        ("DLR","Digital Realty",R),("VICI","VICI Properties",R),("EXR","Extra Space Storage",R),("CBRE","CBRE Group",R),("IRM","Iron Mountain",R)],
 # US territory: companies headquartered in Puerto Rico (all SEC filers, NYSE-listed).
 "PR": [("BPOP","Popular",F),("FBP","First BanCorp",F),("OFG","OFG Bancorp",F),("EVTC","Evertec",F)],
 "CA": [("SHOP.TO","Shopify",T),("CSU.TO","Constellation Software",T),("GIB-A.TO","CGI",T),("OTEX.TO","OpenText",T),
        ("RY.TO","Royal Bank of Canada",F),("TD.TO","Toronto-Dominion Bank",F),("BN.TO","Brookfield Corp",F),("BMO.TO","Bank of Montreal",F),("BNS.TO","Bank of Nova Scotia",F),("CM.TO","CIBC",F),("MFC.TO","Manulife",F),("SLF.TO","Sun Life",F),
        ("BAM.TO","Brookfield Asset Management",F),
        ("QSR.TO","Restaurant Brands",CD),("MG.TO","Magna International",CD),
        ("ATD.TO","Alimentation Couche-Tard",CS),("L.TO","Loblaw",CS),
        ("BCE.TO","BCE",C),("T.TO","Telus",C),("RCI-B.TO","Rogers",C),
        ("CP.TO","Canadian Pacific Kansas City",I),("CNR.TO","Canadian National Railway",I),("TRI.TO","Thomson Reuters",I),("WCN.TO","Waste Connections",I),("CAE.TO","CAE",I),("TFII.TO","TFI International",I),("STN.TO","Stantec",I),
        ("ENB.TO","Enbridge",E),("CNQ.TO","Canadian Natural Resources",E),("SU.TO","Suncor",E),("TRP.TO","TC Energy",E),("CVE.TO","Cenovus",E),("IMO.TO","Imperial Oil",E),("PPL.TO","Pembina Pipeline",E),("CCO.TO","Cameco",E),
        ("AEM.TO","Agnico Eagle",M),("ABX.TO","Barrick",M),("NTR.TO","Nutrien",M),("WPM.TO","Wheaton Precious Metals",M),("FNV.TO","Franco-Nevada",M),("TECK-B.TO","Teck Resources",M),("K.TO","Kinross Gold",M),
        ("FTS.TO","Fortis",U)],
 "MX": [("GFNORTEO.MX","Grupo Financiero Banorte",F),
        ("WALMEX.MX","Walmart de México",CS),("FEMSAUBD.MX","FEMSA",CS),("BIMBOA.MX","Grupo Bimbo",CS),("KOFUBL.MX","Coca-Cola FEMSA",CS),("AC.MX","Arca Continental",CS),
        ("AMXB.MX","América Móvil",C),
        ("GAPB.MX","Grupo Aeroportuario del Pacífico",I),("ASURB.MX","Grupo Aeroportuario del Sureste",I),("OMAB.MX","OMA",I),
        ("GMEXICOB.MX","Grupo México",M),("CEMEXCPO.MX","Cemex",M)],
 "BR": [("ITUB4.SA","Itaú Unibanco",F),("BBDC4.SA","Bradesco",F),("BBAS3.SA","Banco do Brasil",F),("B3SA3.SA","B3",F),("ITSA4.SA","Itaúsa",F),("XP","XP Inc",F),("NU","Nu Holdings",F),("STNE","StoneCo",F),
        ("RDOR3.SA","Rede D'Or",H),
        ("LREN3.SA","Lojas Renner",CD),
        ("ABEV3.SA","Ambev",CS),("RADL3.SA","Raia Drogasil",CS),
        ("VIVT3.SA","Telefônica Brasil",C),
        ("WEGE3.SA","WEG",I),("EMBJ3.SA","Embraer",I),
        ("PETR4.SA","Petrobras",E),("PRIO3.SA","PRIO",E),("UGPA3.SA","Ultrapar",E),
        ("VALE3.SA","Vale",M),("SUZB3.SA","Suzano",M),("GGBR4.SA","Gerdau",M),("CSNA3.SA","CSN",M),
        ("AXIA3.SA","AXIA Energia (Eletrobras)",U),("SBSP3.SA","Sabesp",U),("EQTL3.SA","Equatorial",U),("CMIG4.SA","Cemig",U)],
 "GB": [("ARM","Arm Holdings",T),
        ("HSBA.L","HSBC",F),("LSEG.L","London Stock Exchange Group",F),("BARC.L","Barclays",F),("LLOY.L","Lloyds Banking Group",F),("NWG.L","NatWest",F),("PRU.L","Prudential",F),
        ("AZN.L","AstraZeneca",H),("GSK.L","GSK",H),("SN.L","Smith & Nephew",H),
        ("CPG.L","Compass Group",CD),("IHG.L","InterContinental Hotels",CD),
        ("ULVR.L","Unilever",CS),("BATS.L","British American Tobacco",CS),("DGE.L","Diageo",CS),("TSCO.L","Tesco",CS),("HLN.L","Haleon",CS),
        ("VOD.L","Vodafone",C),
        ("REL.L","RELX",I),("RR.L","Rolls-Royce",I),("BA.L","BAE Systems",I),("EXPN.L","Experian",I),
        ("SHEL.L","Shell",E),("BP.L","BP",E),
        ("RIO.L","Rio Tinto",M),("GLEN.L","Glencore",M),("AAL.L","Anglo American",M),
        ("NG.L","National Grid",U),("SSE.L","SSE",U)],
 "FR": [("CAP.PA","Capgemini",T),("DSY.PA","Dassault Systèmes",T),
        ("BNP.PA","BNP Paribas",F),("CS.PA","AXA",F),("ACA.PA","Crédit Agricole",F),
        ("SAN.PA","Sanofi",H),("EL.PA","EssilorLuxottica",H),
        ("MC.PA","LVMH",CD),("RMS.PA","Hermès",CD),("KER.PA","Kering",CD),
        ("OR.PA","L'Oréal",CS),("BN.PA","Danone",CS),("RI.PA","Pernod Ricard",CS),
        ("ORA.PA","Orange",C),
        ("AIR.PA","Airbus",I),("SU.PA","Schneider Electric",I),("SAF.PA","Safran",I),("DG.PA","Vinci",I),("HO.PA","Thales",I),("SGO.PA","Saint-Gobain",I),
        ("TTE.PA","TotalEnergies",E),
        ("AI.PA","Air Liquide",M),
        ("ENGI.PA","Engie",U)],
 "DE": [("SAP.DE","SAP",T),("IFX.DE","Infineon",T),
        ("ALV.DE","Allianz",F),("MUV2.DE","Munich Re",F),("DB1.DE","Deutsche Börse",F),("DBK.DE","Deutsche Bank",F),("HNR1.DE","Hannover Re",F),("CBK.DE","Commerzbank",F),
        ("BAYN.DE","Bayer",H),("MRK.DE","Merck KGaA",H),("SHL.DE","Siemens Healthineers",H),("FME.DE","Fresenius Medical Care",H),("BNTX","BioNTech",H),
        ("MBG.DE","Mercedes-Benz",CD),("BMW.DE","BMW",CD),("VOW3.DE","Volkswagen",CD),("ADS.DE","Adidas",CD),
        ("DTE.DE","Deutsche Telekom",C),
        ("SIE.DE","Siemens",I),("RHM.DE","Rheinmetall",I),("ENR.DE","Siemens Energy",I),("DHL.DE","DHL Group",I),("MTX.DE","MTU Aero Engines",I),
        ("BAS.DE","BASF",M),
        ("EOAN.DE","E.ON",U),("RWE.DE","RWE",U),
        ("VNA.DE","Vonovia",R)],
 "NL": [("ASML.AS","ASML",T),("ASM.AS","ASM International",T),("BESI.AS","BE Semiconductor",T),("NXPI","NXP Semiconductors",T),
        ("INGA.AS","ING",F),("ADYEN.AS","Adyen",F),("ABN.AS","ABN AMRO",F),("NN.AS","NN Group",F),("EXO.AS","Exor",F),
        ("PHIA.AS","Philips",H),
        ("PRX.AS","Prosus",CD),
        ("HEIA.AS","Heineken",CS),("AD.AS","Ahold Delhaize",CS),
        ("KPN.AS","KPN",C),("UMG.AS","Universal Music Group",C),
        ("WKL.AS","Wolters Kluwer",I),("IMCD.AS","IMCD",I),("RAND.AS","Randstad",I),
        ("AKZA.AS","Akzo Nobel",M)],
 "CH": [("LOGN.SW","Logitech",T),
        ("UBSG.SW","UBS",F),("ZURN.SW","Zurich Insurance",F),("PGHN.SW","Partners Group",F),("SREN.SW","Swiss Re",F),("SLHN.SW","Swiss Life",F),
        ("RO.SW","Roche",H),("NOVN.SW","Novartis",H),("LONN.SW","Lonza",H),("ALC.SW","Alcon",H),
        ("CFR.SW","Richemont",CD),("UHR.SW","Swatch Group",CD),("GRMN","Garmin",CD),("ONON","On Holding",CD),
        ("NESN.SW","Nestlé",CS),
        ("SCMN.SW","Swisscom",C),
        ("ABBN.SW","ABB",I),("KNIN.SW","Kuehne + Nagel",I),("GEBN.SW","Geberit",I),
        ("HOLN.SW","Holcim",M),("SIKA.SW","Sika",M),("GIVN.SW","Givaudan",M)],
 "ES": [("AMS.MC","Amadeus",T),
        ("SAN.MC","Banco Santander",F),("BBVA.MC","BBVA",F),("CABK.MC","CaixaBank",F),("SAB.MC","Banco Sabadell",F),("BKT.MC","Bankinter",F),
        ("GRF.MC","Grifols",H),
        ("ITX.MC","Inditex",CD),
        ("TEF.MC","Telefónica",C),("CLNX.MC","Cellnex",C),
        ("FER.MC","Ferrovial",I),("AENA.MC","Aena",I),("IAG.MC","IAG",I),("ACS.MC","ACS",I),
        ("REP.MC","Repsol",E),
        ("IBE.MC","Iberdrola",U),("ELE.MC","Endesa",U),("NTGY.MC","Naturgy",U)],
 "IT": [("ISP.MI","Intesa Sanpaolo",F),("UCG.MI","UniCredit",F),("G.MI","Generali",F),("MB.MI","Mediobanca",F),("PST.MI","Poste Italiane",F),("BAMI.MI","Banco BPM",F),
        ("RACE.MI","Ferrari",CD),("STLAM.MI","Stellantis",CD),("MONC.MI","Moncler",CD),
        ("LDO.MI","Leonardo",I),("PRY.MI","Prysmian",I),
        ("ENI.MI","Eni",E),("TEN.MI","Tenaris",E),
        ("ENEL.MI","Enel",U),("TRN.MI","Terna",U),("SRG.MI","Snam",U)],
 "SE": [("ERIC-B.ST","Ericsson",T),("HEXA-B.ST","Hexagon",T),
        ("INVE-B.ST","Investor AB",F),("SEB-A.ST","SEB",F),("SHB-A.ST","Handelsbanken",F),("SWED-A.ST","Swedbank",F),
        ("HM-B.ST","H&M",CD),("EVO.ST","Evolution",CD),("ALV","Autoliv",CD),
        ("ESSITY-B.ST","Essity",CS),
        ("TELIA.ST","Telia",C),("SPOT","Spotify",C),
        ("ATCO-A.ST","Atlas Copco",I),("VOLV-B.ST","Volvo",I),("ASSA-B.ST","Assa Abloy",I),("SAND.ST","Sandvik",I),("EPI-A.ST","Epiroc",I),("SAAB-B.ST","Saab",I),("ALFA.ST","Alfa Laval",I)],
 "DK": [("DANSKE.CO","Danske Bank",F),("TRYG.CO","Tryg",F),
        ("NOVO-B.CO","Novo Nordisk",H),("COLO-B.CO","Coloplast",H),("GMAB.CO","Genmab",H),("DEMANT.CO","Demant",H),("ASND","Ascendis Pharma",H),
        ("PNDORA.CO","Pandora",CD),
        ("CARL-B.CO","Carlsberg",CS),
        ("DSV.CO","DSV",I),("MAERSK-B.CO","A.P. Møller-Mærsk",I),("VWS.CO","Vestas",I),
        ("NSIS-B.CO","Novonesis",M),
        ("ORSTED.CO","Ørsted",U)],
 "NO": [("DNB.OL","DNB",F),("GJF.OL","Gjensidige",F),("STB.OL","Storebrand",F),
        ("MOWI.OL","Mowi",CS),("ORK.OL","Orkla",CS),("SALM.OL","SalMar",CS),
        ("TEL.OL","Telenor",C),
        ("KOG.OL","Kongsberg",I),
        ("EQNR.OL","Equinor",E),("AKRBP.OL","Aker BP",E),("FRO","Frontline",E),
        ("NHY.OL","Norsk Hydro",M),("YAR.OL","Yara",M)],
 "FI": [("NOKIA.HE","Nokia",T),
        ("NDA-FI.HE","Nordea",F),("SAMPO.HE","Sampo",F),
        ("ORNBV.HE","Orion",H),
        ("KESKOB.HE","Kesko",CS),
        ("ELISA.HE","Elisa",C),
        ("KNEBV.HE","Kone",I),("WRT1V.HE","Wärtsilä",I),
        ("NESTE.HE","Neste",E),
        ("UPM.HE","UPM",M),("STERV.HE","Stora Enso",M),
        ("FORTUM.HE","Fortum",U)],
 "BE": [("KBC.BR","KBC",F),("AGS.BR","Ageas",F),("GBLB.BR","GBL",F),
        ("ARGX.BR","argenx",H),("UCB.BR","UCB",H),
        ("ABI.BR","AB InBev",CS),
        ("PROX.BR","Proximus",C),
        ("ACKB.BR","Ackermans & van Haaren",I),
        ("SOLB.BR","Solvay",M),("SYENS.BR","Syensqo",M),
        ("ELI.BR","Elia",U),
        ("WDP.BR","WDP",R)],
 "IE": [("ACN","Accenture",T),("STX","Seagate",T),
        ("A5G.IR","AIB Group",F),("BIRG.IR","Bank of Ireland",F),("WTW","Willis Towers Watson",F),
        ("MDT","Medtronic",H),("STE","Steris",H),("ICLR","ICON",H),("JAZZ","Jazz Pharmaceuticals",H),("PRGO","Perrigo",H),
        ("FLUT","Flutter Entertainment",CD),
        ("KRZ.IR","Kerry Group",CS),("GL9.IR","Glanbia",CS),
        ("ETN","Eaton",I),("TT","Trane Technologies",I),("JCI","Johnson Controls",I),("RYA.IR","Ryanair",I),("KRX.IR","Kingspan",I),("AER","AerCap",I),("ALLE","Allegion",I),("PNR","Pentair",I),
        ("CRH","CRH",M),("SW","Smurfit Westrock",M)],
 "PT": [("BCP.LS","Millennium BCP",F),
        ("JMT.LS","Jerónimo Martins",CS),("SON.LS","Sonae",CS),
        ("NOS.LS","NOS",C),
        ("CTT.LS","CTT",I),
        ("GALP.LS","Galp Energia",E),
        ("NVG.LS","Navigator",M),
        ("EDP.LS","EDP",U),("EDPR.LS","EDP Renováveis",U),("RENE.LS","REN",U)],
 "AT": [("EBS.VI","Erste Group",F),("RBI.VI","Raiffeisen Bank International",F),("BG.VI","BAWAG",F),
        ("ANDR.VI","Andritz",I),("POST.VI","Österreichische Post",I),
        ("OMV.VI","OMV",E),
        ("VOE.VI","voestalpine",M),("WIE.VI","Wienerberger",M),
        ("VER.VI","Verbund",U),
        ("CAI.VI","CA Immobilien",R)],
 "JP": [("8035.T","Tokyo Electron",T),("6861.T","Keyence",T),("6981.T","Murata",T),("6702.T","Fujitsu",T),
        ("8306.T","Mitsubishi UFJ",F),("8316.T","Sumitomo Mitsui",F),("8411.T","Mizuho",F),("8766.T","Tokio Marine",F),("8604.T","Nomura",F),("8591.T","ORIX",F),
        ("4568.T","Daiichi Sankyo",H),("4502.T","Takeda",H),("4519.T","Chugai",H),
        ("7203.T","Toyota",CD),("6758.T","Sony",CD),("9983.T","Fast Retailing",CD),("7267.T","Honda",CD),("6902.T","Denso",CD),
        ("2914.T","Japan Tobacco",CS),
        ("9984.T","SoftBank Group",C),("9432.T","NTT",C),("9433.T","KDDI",C),("7974.T","Nintendo",C),
        ("6501.T","Hitachi",I),("8058.T","Mitsubishi Corp",I),("8001.T","Itochu",I),("8031.T","Mitsui & Co",I),("6098.T","Recruit",I),("7011.T","Mitsubishi Heavy",I),("6367.T","Daikin",I),("6503.T","Mitsubishi Electric",I),
        ("4063.T","Shin-Etsu Chemical",M)],
 "CN": [("1810.HK","Xiaomi",T),
        ("1398.HK","ICBC",F),("0939.HK","China Construction Bank",F),("1288.HK","Agricultural Bank of China",F),("3988.HK","Bank of China",F),("2318.HK","Ping An",F),("600036.SS","China Merchants Bank",F),
        ("9988.HK","Alibaba",CD),("PDD","PDD Holdings",CD),("3690.HK","Meituan",CD),("1211.HK","BYD",CD),("9618.HK","JD.com",CD),("9961.HK","Trip.com",CD),("2015.HK","Li Auto",CD),("9866.HK","NIO",CD),
        ("9868.HK","XPeng",CD),("9987.HK","Yum China",CD),("1179.HK","H World",CD),("9901.HK","New Oriental",CD),
        ("600519.SS","Kweichow Moutai",CS),("000858.SZ","Wuliangye",CS),
        ("0700.HK","Tencent",C),("0941.HK","China Mobile",C),("9999.HK","NetEase",C),("9888.HK","Baidu",C),("1698.HK","Tencent Music",C),("9626.HK","Bilibili",C),
        ("300750.SZ","CATL",I),("2057.HK","ZTO Express",I),
        ("0857.HK","PetroChina",E),("0883.HK","CNOOC",E),("1088.HK","China Shenhua",E),
        ("601899.SS","Zijin Mining",M),
        ("600900.SS","China Yangtze Power",U),
        ("2423.HK","KE Holdings",R)],
 "HK": [("1299.HK","AIA Group",F),("0388.HK","Hong Kong Exchanges",F),("2388.HK","BOC Hong Kong",F),
        ("0027.HK","Galaxy Entertainment",CD),
        ("0001.HK","CK Hutchison",I),("0066.HK","MTR",I),("0669.HK","Techtronic Industries",I),
        ("0002.HK","CLP Holdings",U),("0003.HK","Hong Kong & China Gas",U),("0006.HK","Power Assets",U),
        ("0016.HK","Sun Hung Kai Properties",R),("1113.HK","CK Asset",R),("0823.HK","Link REIT",R),("0012.HK","Henderson Land",R)],
 "TW": [("2330.TW","TSMC",T),("2317.TW","Hon Hai (Foxconn)",T),("2454.TW","MediaTek",T),("2308.TW","Delta Electronics",T),("2382.TW","Quanta Computer",T),("3711.TW","ASE Technology",T),("2303.TW","UMC",T),("2345.TW","Accton",T),
        ("3231.TW","Wistron",T),("2357.TW","Asustek",T),
        ("2881.TW","Fubon Financial",F),("2882.TW","Cathay Financial",F),("2891.TW","CTBC Financial",F),("2886.TW","Mega Financial",F),
        ("1216.TW","Uni-President",CS),
        ("2412.TW","Chunghwa Telecom",C),
        ("1301.TW","Formosa Plastics",M),("2002.TW","China Steel",M)],
 "KR": [("005930.KS","Samsung Electronics",T),("000660.KS","SK hynix",T),("006400.KS","Samsung SDI",T),("034220.KS","LG Display",T),
        ("105560.KS","KB Financial",F),("055550.KS","Shinhan Financial",F),("032830.KS","Samsung Life",F),
        ("207940.KS","Samsung Biologics",H),("068270.KS","Celltrion",H),
        ("005380.KS","Hyundai Motor",CD),("000270.KS","Kia",CD),("012330.KS","Hyundai Mobis",CD),("CPNG","Coupang",CD),
        ("035420.KS","NAVER",C),("035720.KS","Kakao",C),("017670.KS","SK Telecom",C),("030200.KS","KT",C),
        ("373220.KS","LG Energy Solution",I),("012450.KS","Hanwha Aerospace",I),("028260.KS","Samsung C&T",I),
        ("005490.KS","POSCO Holdings",M),("051910.KS","LG Chem",M),
        ("015760.KS","KEPCO",U)],
 "IN": [("TCS.NS","Tata Consultancy Services",T),("INFY.NS","Infosys",T),("HCLTECH.NS","HCLTech",T),("WIPRO.NS","Wipro",T),
        ("HDFCBANK.NS","HDFC Bank",F),("ICICIBANK.NS","ICICI Bank",F),("SBIN.NS","State Bank of India",F),("BAJFINANCE.NS","Bajaj Finance",F),("KOTAKBANK.NS","Kotak Mahindra Bank",F),("AXISBANK.NS","Axis Bank",F),
        ("SUNPHARMA.NS","Sun Pharma",H),("DRREDDY.NS","Dr. Reddy's",H),
        ("MARUTI.NS","Maruti Suzuki",CD),("M&M.NS","Mahindra & Mahindra",CD),("TITAN.NS","Titan",CD),("MMYT","MakeMyTrip",CD),
        ("HINDUNILVR.NS","Hindustan Unilever",CS),("ITC.NS","ITC",CS),("NESTLEIND.NS","Nestlé India",CS),
        ("BHARTIARTL.NS","Bharti Airtel",C),
        ("LT.NS","Larsen & Toubro",I),("ADANIENT.NS","Adani Enterprises",I),
        ("RELIANCE.NS","Reliance Industries",E),("ONGC.NS","ONGC",E),("COALINDIA.NS","Coal India",E),
        ("ULTRACEMCO.NS","UltraTech Cement",M),("ASIANPAINT.NS","Asian Paints",M),("TATASTEEL.NS","Tata Steel",M),
        ("NTPC.NS","NTPC",U),("POWERGRID.NS","Power Grid",U)],
 "AU": [("XRO.AX","Xero",T),("WTC.AX","WiseTech Global",T),
        ("CBA.AX","Commonwealth Bank",F),("NAB.AX","National Australia Bank",F),("WBC.AX","Westpac",F),("ANZ.AX","ANZ",F),("MQG.AX","Macquarie",F),("QBE.AX","QBE",F),("SUN.AX","Suncorp",F),
        ("CSL.AX","CSL",H),("RMD.AX","ResMed",H),
        ("WES.AX","Wesfarmers",CD),("ALL.AX","Aristocrat Leisure",CD),
        ("WOW.AX","Woolworths",CS),("COL.AX","Coles",CS),
        ("TLS.AX","Telstra",C),("REA.AX","REA Group",C),
        ("TCL.AX","Transurban",I),
        ("WDS.AX","Woodside",E),
        ("BHP.AX","BHP",M),("RIO.AX","Rio Tinto",M),("FMG.AX","Fortescue",M),("NST.AX","Northern Star",M),("JHX.AX","James Hardie",M),
        ("GMG.AX","Goodman Group",R)],
 "NZ": [("FPH.NZ","Fisher & Paykel Healthcare",H),("EBO.NZ","EBOS Group",H),
        ("ATM.NZ","a2 Milk",CS),
        ("SPK.NZ","Spark NZ",C),
        ("AIA.NZ","Auckland Airport",I),("MFT.NZ","Mainfreight",I),
        ("FBU.NZ","Fletcher Building",M),
        ("IFT.NZ","Infratil",U),("MEL.NZ","Meridian Energy",U),("CEN.NZ","Contact Energy",U)],
 "SG": [("D05.SI","DBS",F),("O39.SI","OCBC",F),("U11.SI","UOB",F),("S68.SI","SGX",F),
        ("G13.SI","Genting Singapore",CD),
        ("F34.SI","Wilmar",CS),("Y92.SI","Thai Beverage",CS),
        ("Z74.SI","Singtel",C),("SE","Sea Limited",C),
        ("C6L.SI","Singapore Airlines",I),("S63.SI","ST Engineering",I),("BN4.SI","Keppel",I),("GRAB","Grab",I),
        ("U96.SI","Sembcorp",U),
        ("C38U.SI","CapitaLand Integrated Commercial Trust",R),("A17U.SI","CapitaLand Ascendas REIT",R),("9CI.SI","CapitaLand Investment",R)],
 "IL": [("NICE.TA","NICE",T),("CHKP","Check Point Software",T),("MNDY","monday.com",T),("WIX","Wix.com",T),("NVMI","Nova",T),("TSEM.TA","Tower Semiconductor",T),("MBLY","Mobileye",T),
        ("LUMI.TA","Bank Leumi",F),("POLI.TA","Bank Hapoalim",F),("DSCT.TA","Israel Discount Bank",F),("MZTF.TA","Mizrahi Tefahot",F),
        ("TEVA.TA","Teva Pharmaceutical",H),
        ("BEZQ.TA","Bezeq",C),
        ("ESLT.TA","Elbit Systems",I),
        ("ICL.TA","ICL Group",M),
        ("AZRG.TA","Azrieli",R)],
 "ZA": [("FSR.JO","FirstRand",F),("SBK.JO","Standard Bank",F),("CPI.JO","Capitec",F),("ABG.JO","Absa",F),("NED.JO","Nedbank",F),("SLM.JO","Sanlam",F),("DSY.JO","Discovery",F),("REM.JO","Remgro",F),
        ("NPN.JO","Naspers",CD),
        ("SHP.JO","Shoprite",CS),("BID.JO","Bid Corporation",CS),("CLS.JO","Clicks Group",CS),
        ("MTN.JO","MTN Group",C),("VOD.JO","Vodacom",C),
        ("GFI.JO","Gold Fields",M),("ANG.JO","AngloGold Ashanti",M),("AGL.JO","Anglo American",M),("SOL.JO","Sasol",M),("SSW.JO","Sibanye-Stillwater",M),("HAR.JO","Harmony Gold",M)],
 "SA": [("7203.SR","Elm",T),
        ("1120.SR","Al Rajhi Bank",F),("1180.SR","Saudi National Bank",F),("1150.SR","Alinma Bank",F),("1010.SR","Riyad Bank",F),("1060.SR","Saudi Awwal Bank",F),
        ("4013.SR","Dr. Sulaiman Al Habib",H),
        ("2280.SR","Almarai",CS),
        ("7010.SR","STC",C),
        ("2222.SR","Saudi Aramco",E),
        ("2010.SR","SABIC",M),("1211.SR","Ma'aden",M),
        ("2082.SR","ACWA Power",U),("5110.SR","Saudi Electricity",U)],
}


LIST_AS_OF = "2026"


@dataclass(frozen=True)
class Leader:
    rank: int  # by live market cap (USD) within the country; companies without one follow in list order
    symbol: str
    name: str
    sector: str
    snapshot: Snapshot | None
    coverage: str  # "sec" (free, full statements) | "fmp" | "fmp_key_required" | "unavailable"
    market_cap: float | None = None  # in the listing's price currency
    market_cap_usd: float | None = None


# US listings in the non-US lists that are depositary receipts for several shares (price × ordinary
# shares would overstate the market cap). The rest trade as ordinary shares or 1:1 ADSs.
US_DEPOSITARY_RECEIPTS = frozenset({"PDD"})
# Yahoo rate-limits bursts: a 240-stock country list fetches its quotes a few at a time.
_SNAPSHOT_CONCURRENCY = 6


async def _route(router: DataRouter, fmp: FmpClient, symbol: str) -> tuple[str, int | None]:
    """(coverage, SEC CIK when it's an SEC registrant) — from the cached EDGAR ticker map only.

    Home listings count as SEC registrants only when curated in SEC_REGISTRANT_FOR_LISTING, so opening
    a country never fetches per-company EDGAR submissions (SEC throttles bursts). Loading a company with
    the arrow still runs the full router.
    """
    listing = parse_listing(symbol)
    if listing is not None and symbol not in SEC_REGISTRANT_FOR_LISTING:
        return ("fmp" if fmp.configured else "fmp_key_required"), None
    try:
        route = await router.resolve(symbol)
    except CompanyNotFoundError:
        return "unavailable", None
    except SecApiError:
        # SEC is throttling or unreachable: US tickers and curated listings are SEC registrants anyway,
        # so keep them addable rather than marking them as having no data.
        return "sec", None
    if route.source is DataSource.SEC:
        return "sec", route.cik
    return ("fmp" if fmp.configured else "fmp_key_required"), None


async def country_leaders(
    iso2: str, quotes: QuoteService, router: DataRouter, fmp: FmpClient, caps: MarketCaps
) -> list[Leader] | None:
    """None when the country has no curated list. Ranked by live market cap."""
    iso2 = iso2.upper()
    entries = LEADERS.get(iso2)
    if entries is None:
        return None
    gate = asyncio.Semaphore(_SNAPSHOT_CONCURRENCY)

    async def snapshot(symbol: str) -> Snapshot | None:
        async with gate:
            return await quotes.get_snapshot(symbol)

    snapshots, routes, shares = await asyncio.gather(
        asyncio.gather(*(snapshot(s) for s, _, _ in entries)),
        asyncio.gather(*(_route(router, fmp, s) for s, _, _ in entries)),
        caps.shares_by_cik(),
    )
    currencies = {snap.currency for snap in snapshots if snap}
    usd = dict(zip(currencies, await asyncio.gather(*(caps.usd_rate(c) for c in currencies))))

    leaders: list[Leader] = []
    for (symbol, name, sector), snap, (coverage, cik) in zip(entries, snapshots, routes):
        cap = cap_usd = None
        if snap and cik is not None and cik in shares and symbol not in US_DEPOSITARY_RECEIPTS:
            cap = snap.price * shares[cik]
            rate = usd.get(snap.currency)
            cap_usd = cap * rate if rate else None
        leaders.append(Leader(0, symbol, name, sector, snap, coverage, cap, cap_usd))

    order = sorted(range(len(leaders)), key=lambda i: (leaders[i].market_cap_usd is None, -(leaders[i].market_cap_usd or 0), i))
    return [replace(leaders[i], rank=r + 1) for r, i in enumerate(order)]
