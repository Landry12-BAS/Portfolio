// The clauses of the synthetic supply agreements (LB-04's seed data). A wholesale supply agreement
// between Basalt & Bean Coffee Co. s.r.o. (the supplier) and a hotel group (the customer), as the
// customer's lawyers might draft it. Every name, address and number is invented.
//
// The clauses are written once and chosen by `Terms`: each term the playbook cares about has a
// risky wording and a fair one, so one contract can plant exactly the risks its test needs. The
// words a detector searches for (data/seed/lb04/playbook.yaml) are present in the fair wordings
// and absent from the risky ones, and the offline test checks that this is so.
//
// Numbering is not written here: articles and clauses are numbered in the order they come, so
// adding an indemnity article moves the numbers after it, as in a real contract.
import type { Block, TableColumn } from './layout.ts'

/** A clause: its text, and the lettered items under it, if any. */
export interface ClauseSpec {
  text: string
  items?: readonly string[]
}

/** An article: a numbered heading and its clauses. */
export interface ArticleSpec {
  heading: string
  clauses: readonly (string | ClauseSpec)[]
}

/** The wording chosen for each term the playbook reads. */
export interface Terms {
  // Clause 3.2: renewal by a long notice, or by a short one.
  renewal: 'long-notice' | 'fair'
  // Clause 5.3: payment after ninety days, or after thirty.
  payment: 'net90' | 'net30'
  // Article 9: the supplier's recipes are assigned to the customer, or each side keeps its own.
  ip: 'assignment' | 'fair'
  // The liability article: unlimited, or capped.
  liability: 'unlimited' | 'capped'
  // Whether there is an indemnity article.
  indemnity: 'none' | 'mutual'
  // Clause 2.4: the supplier is tied to the customer, or free to supply others.
  exclusivity: 'supplier-bound' | 'none'
}

/** The parties, as the front page and the opening paragraphs give them. */
export const PARTIES = {
  supplier: 'Basalt & Bean Coffee Co. s.r.o.',
  supplierDescription: 'a company incorporated in the Czech Republic with registered number 01234567, whose registered office is at 12 Roastery Lane, 110 00 Prague 1',
  customer: 'Vltava Grand Hotels a.s.',
  customerDescription: 'a company incorporated in the Czech Republic with registered number 87654321, whose registered office is at 5 Riverside Quay, 110 00 Prague 1',
} as const

/** The products the agreements are about: the names and kilograms of Basalt & Bean's wholesale list (data/seed/lb08/stock.yaml), with invented prices. */
export const PRODUCTS: readonly (readonly [string, string, string, string])[] = [
  ['Basalt Blend 1 kg', '1 kg bag', '18.40', 'Medium roast, cupping score 84 or more'],
  ['Colombia Huila Espresso 1 kg', '1 kg bag', '21.90', 'Medium-dark roast, cupping score 85 or more'],
  ['Ethiopia Guji Filter 1 kg', '1 kg bag', '24.60', 'Light roast, cupping score 87 or more'],
  ['Kenya Nyeri Filter 1 kg', '1 kg bag', '25.80', 'Light roast, cupping score 87 or more'],
  ['Decaf Sugarcane 1 kg', '1 kg bag', '22.30', 'Medium roast, cupping score 83 or more'],
  ['House Espresso 5 kg bag', '5 kg bag', '16.90', 'Medium-dark roast, cupping score 83 or more'],
]

/** The first three articles' worth of definitions: what the capitalised words mean. */
function definitions(): ArticleSpec {
  return {
    heading: 'DEFINITIONS AND INTERPRETATION',
    clauses: [
      {
        text: 'In this Agreement the following words have these meanings:',
        items: [
          '“Agreement” means this agreement, including its Schedules;',
          '“Business Day” means a day other than a Saturday, a Sunday or a public holiday in the Czech Republic;',
          '“Delivery Point” means each hotel or cafe of the Customer named in a Purchase Order;',
          '“Products” means the roasted coffee products listed in Schedule 1, in the pack sizes stated there;',
          '“Purchase Order” means a written order for Products placed by the Customer under clause 4;',
          '“Specification” means the quality specification for each Product in Schedule 1, and the Supplier’s cupping standard in force when the Product was roasted;',
          '“Term” has the meaning given in clause 3.3.',
        ],
      },
      'Headings do not affect the interpretation of this Agreement. A reference to a clause or a Schedule is to a clause of, or a Schedule to, this Agreement. A reference to writing includes email, but not any other electronic message.',
      'Words in the singular include the plural and the other way round. The words “including” and “in particular” do not limit the words that come before them.',
    ],
  }
}

/** The supply article. Its fourth clause is where an exclusivity would sit. */
function supply(terms: Terms): ArticleSpec {
  const exclusivity = terms.exclusivity === 'supplier-bound'
    ? 'During the Term the Supplier shall not supply coffee to any other hotel, cafe or restaurant within five (5) kilometres of a Delivery Point, and shall offer the Customer the lowest price at which it sells the same Product to any other customer.'
    : 'Nothing in this Agreement obliges the Customer to buy a minimum quantity of Products, or stops the Supplier from supplying other customers or the Customer from buying coffee from other suppliers.'
  return {
    heading: 'SUPPLY OF PRODUCTS',
    clauses: [
      'During the Term the Supplier shall supply, and the Customer shall buy, the Products that the Customer orders under clause 4, on the terms of this Agreement.',
      'The Supplier shall supply the Products with the care and skill to be expected of a specialty roaster, and shall make sure that each Product matches its Specification and is fit to be served to the public.',
      'The Supplier shall use reasonable endeavours to keep enough green coffee in stock to meet the forecasts that the Customer gives under clause 4.2. If the Supplier cannot supply a Product, it shall tell the Customer without delay and offer the nearest equivalent Product, which the Customer may accept or refuse.',
      exclusivity,
    ],
  }
}

/** The term and renewal article. The second clause is the renewal the playbook reads. */
function term(terms: Terms): ArticleSpec {
  const renewal = terms.renewal === 'long-notice'
    ? 'This Agreement shall renew automatically for successive periods of twelve (12) months each unless either party gives the other written notice of non-renewal at least one hundred and eighty (180) days before the end of the then-current term.'
    : 'This Agreement shall renew automatically for successive periods of twelve (12) months each unless either party gives the other written notice of non-renewal at least sixty (60) days before the end of the then-current term.'
  return {
    heading: 'TERM AND RENEWAL',
    clauses: [
      'This Agreement starts on 1 November 2026 and, unless it ends earlier under clause {termination}, continues for an initial period of twenty-four (24) months (the “Initial Term”).',
      renewal,
      'The Initial Term and each period for which this Agreement renews are together the “Term”. The prices in Schedule 1 apply during the Initial Term and may be reviewed under clause 5.5 afterwards.',
    ],
  }
}

/** The orders article. */
function orders(): ArticleSpec {
  return {
    heading: 'ORDERS AND FORECASTS',
    clauses: [
      'The Customer shall order Products by sending the Supplier a Purchase Order by email, stating the Products, the quantities, the Delivery Point and the delivery date it wants.',
      'By the fifteenth day of each month the Customer shall give the Supplier a non-binding forecast of the Products it expects to order in the following three (3) months. The forecast is given in good faith to help the Supplier plan its roasting and purchasing, and does not bind the Customer to buy.',
      'The Supplier shall confirm or refuse each Purchase Order within two (2) Business Days of receiving it. A Purchase Order that the Supplier has not refused within that time is accepted.',
      'The Supplier shall accept a Purchase Order that is within the Customer’s latest forecast and gives at least five (5) Business Days’ notice. For other Purchase Orders it shall use reasonable endeavours to supply by the date requested.',
      'The Customer may change or cancel a Purchase Order without charge until the Supplier has started roasting the Products it covers.',
    ],
  }
}

/** The price and payment article. The third clause is the payment term the playbook reads. */
function price(terms: Terms): ArticleSpec {
  const payment = terms.payment === 'net90'
    ? 'The Customer shall pay each undisputed invoice within ninety (90) days of the date of the invoice, by bank transfer to the account stated on the invoice.'
    : 'The Customer shall pay each undisputed invoice within thirty (30) days of the date of the invoice, by bank transfer to the account stated on the invoice. Interest accrues on an overdue amount at the statutory rate from the due date until it is paid.'
  return {
    heading: 'PRICE AND PAYMENT',
    clauses: [
      'The price of each Product is the price per kilogram stated for it in Schedule 1, exclusive of value added tax. The prices include packaging, and delivery to a Delivery Point in the Czech Republic.',
      'The Supplier shall invoice the Customer for each delivery on or after the date of delivery. Each invoice shall state the Purchase Order it relates to, the Products and quantities delivered, the price and the value added tax due.',
      payment,
      'If the Customer disputes an invoice in good faith, it shall tell the Supplier in writing within fourteen (14) days of receiving it, giving its reasons, and shall pay the part that is not in dispute. The parties shall try to settle the dispute within thirty (30) days.',
      'The Supplier may propose new prices for the Products by written notice given at least ninety (90) days before the end of the Initial Term or of any later period. Prices change only if the Customer agrees in writing. If it does not, the existing prices continue to apply.',
    ],
  }
}

/** The delivery article. */
function delivery(): ArticleSpec {
  return {
    heading: 'DELIVERY AND RISK',
    clauses: [
      'The Supplier shall deliver the Products to the Delivery Point stated in each Purchase Order, within the delivery window for that Delivery Point in Schedule 2, on the date the Supplier has confirmed.',
      'The Supplier shall deliver in sealed, labelled packaging marked with the Product’s name, its roast date and a lot code. The Customer shall make sure that someone is present to receive each delivery, and shall sign the delivery note.',
      'Risk in the Products passes to the Customer on delivery. Ownership passes when the Customer has paid for them in full.',
      'If the Supplier delivers more or less than ordered, the Customer may reject the excess or accept it at the stated price. The Customer shall pay only for what it accepts, and the Supplier shall deliver any shortfall within three (3) Business Days.',
      'Delivery dates are given in good faith. If the Supplier expects to deliver late it shall tell the Customer straight away and say when delivery will be made.',
    ],
  }
}

/** The warranties article: what each party promises about itself and the Products. */
function warranties(): ArticleSpec {
  return {
    heading: 'WARRANTIES',
    clauses: [
      'The Supplier warrants that, when it delivers them, the Products will match their Specification, will be of satisfactory quality and fit for human consumption, and will have been roasted, packed, labelled and stored in accordance with the law.',
      'The Supplier warrants that it has the right to sell the Products and that ownership of them will pass to the Customer free from any charge or security.',
      'The Customer warrants that it will store and serve the Products in accordance with the instructions on their packaging, and will not alter or re-label them in a way that makes them misleading.',
      'Each party warrants that it has the power to enter into this Agreement and that doing so does not put it in breach of any other agreement.',
    ],
  }
}

/** The service levels article, which refers to Schedule 3. */
function serviceLevels(): ArticleSpec {
  return {
    heading: 'SERVICE LEVELS AND REPORTING',
    clauses: [
      'The Supplier shall meet the service levels in Schedule 3 for the accuracy, the timeliness and the completeness of its deliveries.',
      'Within ten (10) Business Days after the end of each calendar quarter the Supplier shall send the Customer a report of its performance against the service levels in that quarter, with the number of deliveries made, the number made late and the number of complaints received.',
      'If the Supplier misses a service level in two consecutive months, the parties shall meet within fifteen (15) Business Days to agree a plan to put it right. The plan shall be in writing and shall say who will do what and by when.',
      'The Customer’s remedies for a failure to meet a service level are those in clause 7.3 and the plan under clause 10.3, and the parties shall consider in good faith any further remedy that the plan proposes.',
    ],
  }
}

/** The training and support article. */
function training(): ArticleSpec {
  return {
    heading: 'TRAINING AND SUPPORT',
    clauses: [
      'The Supplier shall give a barista training session of up to three (3) hours, free of charge, at each new Delivery Point within the first sixty (60) days after the first delivery to it.',
      'The Supplier shall make a coffee specialist available by telephone and email on Business Days between 08:00 and 17:00 to answer questions about brewing, grinding, storing and serving the Products.',
      'The Supplier shall give the Customer a brewing guide for each Product, and shall update it when the recipe for a Product changes.',
      'Further training, equipment servicing and tastings are provided at the Supplier’s rates in force at the time, as agreed in writing in advance.',
    ],
  }
}

/** The subcontracting article. */
function subcontracting(): ArticleSpec {
  return {
    heading: 'SUBCONTRACTING',
    clauses: [
      'The Supplier may use subcontractors to roast, pack or deliver the Products, provided that it tells the Customer who they are and remains responsible for what they do or fail to do as if it were the Supplier’s own act or omission.',
      'The Supplier shall make sure that each subcontractor is bound by terms that protect Confidential Information as this Agreement requires, and that it complies with the laws on food safety.',
      'The Customer may object to a subcontractor on reasonable grounds relating to food safety, and the parties shall then discuss in good faith how to resolve the objection.',
    ],
  }
}

/** The insurance article. */
function insurance(): ArticleSpec {
  return {
    heading: 'INSURANCE',
    clauses: [
      'The Supplier shall keep in force, during the Term and for twelve (12) months afterwards, product safety insurance with a reputable insurer for at least two million euros (EUR 2,000,000) for each claim.',
      'The Customer shall keep in force, during the Term, insurance of the kinds that a prudent operator of hotels and cafes would keep, including public liability insurance.',
      'Each party shall give the other a certificate of its insurance on request.',
    ],
  }
}

/** The data protection article. */
function dataProtection(): ArticleSpec {
  return {
    heading: 'DATA PROTECTION',
    clauses: [
      'Each party shall comply with the law on the protection of personal data in connection with this Agreement, including Regulation (EU) 2016/679.',
      'The parties expect to exchange only the business contact details of their staff. Each shall use the other’s contact details only to perform this Agreement and shall keep them secure.',
      'If a party becomes aware of a breach of the security of the other’s personal data, it shall tell the other without undue delay.',
    ],
  }
}

/** The ethical sourcing article. */
function sourcing(): ArticleSpec {
  return {
    heading: 'ETHICAL SOURCING AND SUSTAINABILITY',
    clauses: [
      'The Supplier shall buy green coffee only from sources that it has reasonably checked comply with the laws on labour, health and safety and the environment in the country of origin, and shall not knowingly buy coffee that was produced using forced or child labour.',
      'On request, the Supplier shall tell the Customer the country and, where it knows them, the farm or cooperative of origin of each Product.',
      'The Supplier shall use packaging that can be recycled or composted where that is available at a reasonable cost, and shall tell the Customer what the packaging is made of.',
      'Each party shall comply with its own code of conduct on ethical sourcing and shall give the other a copy of it on request.',
    ],
  }
}

/** The samples and new products article. */
function samples(): ArticleSpec {
  return {
    heading: 'SAMPLES AND NEW PRODUCTS',
    clauses: [
      'The Supplier shall tell the Customer when it introduces a new coffee or a new seasonal blend, and shall give the Customer a free tasting sample of up to two hundred and fifty (250) grams of each on request.',
      'The Customer may ask the Supplier to add a coffee to Schedule 1. The Supplier shall reply within ten (10) Business Days, giving a price and a minimum order if it agrees. A coffee is added only when both parties have confirmed the price in writing.',
      'The Supplier may stop selling a Product if the green coffee it is roasted from is no longer available at a reasonable price, provided that it gives the Customer at least sixty (60) days’ written notice and offers the nearest equivalent Product.',
    ],
  }
}

/** The marketing article. */
function marketing(): ArticleSpec {
  return {
    heading: 'MARKETING AND PROMOTION',
    clauses: [
      'The Supplier shall give the Customer, free of charge, the menus, posters, table cards and digital images that it makes to promote the Products, and the Customer may use them in its hotels and cafes during the Term.',
      'The Customer shall show the Products on its menus under the names given in Schedule 1, and shall tell the Supplier before it runs a promotion that features a Product by name.',
      'Neither party shall make a public statement about this Agreement without the other’s written consent, except as the law requires.',
    ],
  }
}

/** The business continuity article. */
function continuity(): ArticleSpec {
  return {
    heading: 'BUSINESS CONTINUITY',
    clauses: [
      'The Supplier shall keep a stock of roasted and green coffee sufficient to meet the Customer’s forecast orders for at least fourteen (14) days.',
      'The Supplier shall keep a written plan for continuing to roast and deliver if its roastery is closed or its supply of green coffee is interrupted, and shall give the Customer a summary of the plan on request.',
      'If the Supplier cannot roast at its own roastery, it may use another roastery that meets the standards in this Agreement for as long as the problem lasts, and shall tell the Customer without delay.',
    ],
  }
}

/** The quality article. */
function quality(): ArticleSpec {
  return {
    heading: 'QUALITY, INSPECTION AND COMPLAINTS',
    clauses: [
      'The Supplier shall roast each Product within seven (7) days before it delivers it, and shall give the roast date and the lot code of each delivery on the delivery note.',
      'The Customer shall inspect each delivery within five (5) Business Days of receiving it, and shall tell the Supplier in writing of any Product that does not match the Specification, giving enough detail to identify the lot.',
      'If a Product does not match the Specification, the Supplier shall, at the Customer’s choice, replace it at no charge within five (5) Business Days or credit the price paid for it. The Customer shall keep the Product available for inspection until the Supplier has examined it.',
      'The Supplier shall keep a sample of each lot for twelve (12) months after delivery, and shall give the Customer the result of any quality test of the lot on request.',
    ],
  }
}

/** The food safety article. */
function foodSafety(): ArticleSpec {
  return {
    heading: 'FOOD SAFETY AND COMPLIANCE',
    clauses: [
      'The Supplier shall comply with the laws that apply to roasting, packing, labelling and selling coffee in the Czech Republic and the European Union, including the rules on food hygiene, traceability and allergens.',
      'The Supplier shall keep records that let it trace each lot of green coffee through roasting and packing to the customers that received it, and shall give the Customer the records for any lot on request within two (2) Business Days.',
      'If the Supplier learns that a Product it has delivered may be unsafe, it shall tell the Customer at once and shall co-operate in any recall or withdrawal that the law requires or that either party reasonably considers necessary.',
      'The Customer may audit the Supplier’s roastery once in each calendar year, on at least ten (10) Business Days’ notice and during working hours, to check the Supplier’s compliance with this clause. The Customer shall not disturb the Supplier’s operations more than it must.',
      'Each party shall comply with the laws on bribery, sanctions and the protection of personal data that apply to it, and shall not do anything that puts the other in breach of them.',
    ],
  }
}

/** The intellectual property article. The second clause is what the playbook reads. */
function intellectualProperty(terms: Terms): ArticleSpec {
  const clauses: (string | ClauseSpec)[] = terms.ip === 'assignment'
    ? [
        'The Supplier grants the Customer a non-exclusive licence to use the Supplier’s name and logo to describe the Products in the Customer’s hotels and cafes during the Term.',
        'All intellectual property rights in the Products and in any blend formulation, roast profile, cupping specification or packaging design developed or used by the Supplier for the Customer under this Agreement shall vest in the Customer on creation, and the Supplier hereby assigns all such rights to the Customer with full title guarantee.',
        'The Supplier shall do everything the Customer reasonably asks, at the Customer’s cost, to give effect to clause {intellectual property}.2, including signing documents.',
        'The Customer shall not use the Supplier’s name or logo in a way that suggests that the Supplier endorses anything other than the Products.',
      ]
    : [
        'The Supplier grants the Customer a non-exclusive licence to use the Supplier’s name and logo to describe the Products in the Customer’s hotels and cafes during the Term.',
        'Each party keeps all intellectual property rights in its own materials. For the Supplier these include its blend formulations, roast profiles, cupping specifications and packaging designs, which the Supplier does not assign or license to the Customer under this Agreement.',
        'The Customer shall not use the Supplier’s name or logo in a way that suggests that the Supplier endorses anything other than the Products.',
        'The Supplier confirms that, to its knowledge, the Products and their packaging do not infringe the intellectual property rights of any third party.',
      ]
  return { heading: 'INTELLECTUAL PROPERTY', clauses }
}

/** The confidentiality article: mutual, for the term and three years. */
function confidentiality(): ArticleSpec {
  return {
    heading: 'CONFIDENTIALITY',
    clauses: [
      'Each party shall keep confidential all information of a confidential nature that it receives from the other under or in connection with this Agreement, including the other’s prices, customers, recipes, methods and business plans (“Confidential Information”). It shall use Confidential Information only to perform this Agreement, and shall not disclose it to anyone except as clause {confidentiality}.2 allows.',
      'A party may disclose Confidential Information to its employees, professional advisers and insurers who need to know it and who are bound to keep it confidential, and to the extent that the law, a court or a regulator requires.',
      'The duty of confidence does not apply to information that is or becomes public other than through a breach of this Agreement, that the receiving party already knew without a duty of confidence, or that it develops independently.',
      'The obligations in this clause continue during the Term and for three (3) years after this Agreement ends.',
    ],
  }
}

/** The liability article: unlimited, or capped. */
function liability(terms: Terms): ArticleSpec {
  if (terms.liability === 'unlimited') {
    return {
      heading: 'LIABILITY',
      clauses: [
        'The Supplier’s liability to the Customer under or in connection with this Agreement, whether in contract, tort (including negligence) or otherwise, shall be unlimited, and shall include liability for loss of profit, loss of business and any indirect or consequential loss.',
        'Nothing in this Agreement limits or excludes a party’s liability for death or personal injury caused by its negligence, for fraud, or for anything else that the law does not allow to be limited or excluded.',
        'The Customer shall tell the Supplier of any claim against the Customer that may lead to a claim against the Supplier under this Agreement as soon as it reasonably can.',
      ],
    }
  }
  return {
    heading: 'LIMITATION OF LIABILITY',
    clauses: [
      'Each party’s total aggregate liability to the other under or in connection with this Agreement, whether in contract, tort (including negligence) or otherwise, shall not exceed the total price paid or payable for the Products supplied under this Agreement in the twelve (12) months before the event giving rise to the claim.',
      'Neither party shall be liable to the other for any loss of profit, loss of business, loss of goodwill or any indirect or consequential loss arising under or in connection with this Agreement.',
      'Nothing in this Agreement limits or excludes a party’s liability for death or personal injury caused by its negligence, for fraud, or for anything else that the law does not allow to be limited or excluded.',
    ],
  }
}

/** The indemnity article, when there is one: mutual and within the cap. */
function indemnity(): ArticleSpec {
  return {
    heading: 'INDEMNITY',
    clauses: [
      'Each party shall indemnify the other against third-party claims to the extent that they arise from its own breach of this Agreement, its own negligence or the infringement of intellectual property rights by its own materials, subject to the limit of liability in this Agreement.',
      'A party that wants to rely on this clause shall tell the other promptly of the claim, let the other take over its defence at the other’s cost, and not settle the claim without the other’s written consent.',
    ],
  }
}

/** The termination article: either party, for an uncured breach or insolvency. */
function termination(): ArticleSpec {
  return {
    heading: 'TERMINATION',
    clauses: [
      'Either party may terminate this Agreement by written notice with immediate effect if the other party commits a material breach of it that cannot be put right, or that it fails to put right within thirty (30) days of a written notice requiring it to do so.',
      'Either party may terminate this Agreement by written notice with immediate effect if the other party becomes insolvent, enters liquidation, or has a petition for its insolvency filed against it that is not dismissed within sixty (60) days.',
      'When this Agreement ends for any reason, the Customer shall pay for all Products delivered, each party shall return or delete the other’s Confidential Information, and the clauses that by their nature continue after it ends shall continue.',
    ],
  }
}

/** The force majeure article. */
function forceMajeure(): ArticleSpec {
  return {
    heading: 'FORCE MAJEURE',
    clauses: [
      'Neither party is in breach of this Agreement, or liable for a delay in performing it, to the extent that the delay is caused by an event beyond its reasonable control, such as flood, fire, storm, war, an epidemic, a strike that is not of its own staff, a failure of public power or transport networks, or the closure of a port, so long as it tells the other party promptly and does what it reasonably can to reduce the effect.',
      'If an event of this kind continues for more than sixty (60) days, either party may end this Agreement by written notice to the other.',
    ],
  }
}

/** The notices article. */
function notices(): ArticleSpec {
  return {
    heading: 'NOTICES',
    clauses: [
      'A notice under this Agreement must be in writing, in English, and sent by email to the address that the receiving party has given for notices, with a copy by registered post to its registered office. A notice sent by email is received on the next Business Day after it is sent, unless the sender receives a message that it was not delivered.',
      'Each party shall tell the other without delay if its address for notices changes.',
    ],
  }
}

/** The general article. */
function general(extra: readonly string[] = []): ArticleSpec {
  return {
    heading: 'GENERAL',
    clauses: [
      'Neither party may assign or transfer its rights or obligations under this Agreement without the other’s written consent, which shall not be unreasonably withheld.',
      'This Agreement is the whole agreement between the parties about its subject. It replaces everything they said or wrote before about it, and neither party has relied on anything that is not written in it.',
      'A change to this Agreement is effective only if it is in writing and signed by both parties.',
      'If a part of this Agreement is found to be invalid or unenforceable, the rest stays in force and the parties shall replace the invalid part with a valid one that comes as close as possible to what they meant.',
      'A party that does not use a right under this Agreement on one occasion does not give it up for the future.',
      'This Agreement may be signed in counterparts, including by electronic signature, each of which is an original.',
      ...extra,
    ],
  }
}

/** The governing law article: Czech law and courts. */
function governingLaw(): ArticleSpec {
  return {
    heading: 'GOVERNING LAW AND DISPUTES',
    clauses: [
      'This Agreement and any dispute or claim arising out of or in connection with it, including a non-contractual one, shall be governed by the law of the Czech Republic.',
      'The parties shall first try to settle any dispute through their managing directors. If it is not settled within thirty (30) days, the courts of the Czech Republic, and in the first instance the Municipal Court in Prague, shall have exclusive jurisdiction.',
    ],
  }
}

/** The articles of a full agreement, in order, for the given terms. */
export function fullArticles(terms: Terms): ArticleSpec[] {
  return [
    definitions(),
    supply(terms),
    term(terms),
    orders(),
    price(terms),
    delivery(),
    quality(),
    warranties(),
    foodSafety(),
    serviceLevels(),
    training(),
    subcontracting(),
    insurance(),
    dataProtection(),
    sourcing(),
    samples(),
    marketing(),
    continuity(),
    intellectualProperty(terms),
    confidentiality(),
    liability(terms),
    ...(terms.indemnity === 'mutual' ? [indemnity()] : []),
    termination(),
    forceMajeure(),
    notices(),
    general(),
    governingLaw(),
  ]
}

/** The articles of a short agreement, as the hostile contract has it: fewer articles, the same wording. */
export function shortArticles(terms: Terms, generalExtra: readonly string[], definitionExtra: string): ArticleSpec[] {
  const defs = definitions()
  const withExtra: ArticleSpec = { ...defs, clauses: [{ ...(defs.clauses[0] as ClauseSpec), items: [...((defs.clauses[0] as ClauseSpec).items ?? []), definitionExtra] }, ...defs.clauses.slice(1)] }
  return [
    withExtra,
    supply(terms),
    term(terms),
    orders(),
    price(terms),
    delivery(),
    liability(terms),
    termination(),
    confidentiality(),
    general(generalExtra),
    governingLaw(),
  ]
}

/** The price list: the products, their packs and prices, and what each must be. */
export function priceSchedule(): Block[] {
  const columns: TableColumn[] = [
    { header: 'Product', x: 0 },
    { header: 'Pack', x: 190 },
    { header: 'EUR per kg', x: 300, align: 'right' },
    { header: 'Specification', x: 310 },
  ]
  return [
    { type: 'heading', number: 'Schedule 1', text: 'PRODUCTS AND PRICES' },
    { type: 'paragraph', text: 'Prices are in euros per kilogram, exclusive of value added tax, and include packaging and delivery to a Delivery Point in the Czech Republic.' },
    { type: 'table', columns, rows: PRODUCTS.map(([name, pack, euros, specification]) => [name, pack, euros, specification]) },
  ]
}

/** The service levels the supplier is held to, and how often each is measured. */
export function serviceSchedule(): Block[] {
  const columns: TableColumn[] = [
    { header: 'Measure', x: 0 },
    { header: 'Target', x: 330, align: 'right' },
    { header: 'Measured', x: 360 },
  ]
  return [
    { type: 'heading', number: 'Schedule 3', text: 'SERVICE LEVELS' },
    { type: 'paragraph', text: 'Each measure is the share of deliveries or Purchase Orders in the period that meet it. The Supplier reports on them under clause 10.2.' },
    { type: 'table', columns, rows: [
      ['Deliveries made on the date the Supplier confirmed', '97%', 'Monthly'],
      ['Deliveries complete, with every line as ordered', '99%', 'Monthly'],
      ['Deliveries with a roast date within seven days', '100%', 'Monthly'],
      ['Purchase Orders confirmed within two Business Days', '98%', 'Monthly'],
      ['Complaints answered within two Business Days', '95%', 'Monthly'],
      ['Lots that match their Specification', '99%', 'Quarterly'],
    ] },
  ]
}

/** The delivery windows: where and when the supplier delivers. */
export function deliverySchedule(): Block[] {
  const columns: TableColumn[] = [
    { header: 'Delivery Point', x: 0 },
    { header: 'Days', x: 190 },
    { header: 'Window', x: 290 },
    { header: 'Order by', x: 370 },
  ]
  return [
    { type: 'heading', number: 'Schedule 2', text: 'DELIVERY WINDOWS' },
    { type: 'table', columns, rows: [
      ['Prague hotels', 'Mon, Wed, Fri', '07:00-11:00', '10:00 the day before'],
      ['Prague cafes', 'Tue, Thu', '08:00-12:00', '10:00 the day before'],
      ['Brno hotels and cafes', 'Mon, Thu', '08:00-14:00', '10:00 two days before'],
      ['Ostrava hotels', 'Wed', '09:00-15:00', '10:00 two days before'],
    ] },
  ]
}
