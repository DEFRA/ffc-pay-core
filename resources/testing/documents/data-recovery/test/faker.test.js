const assert = require('node:assert/strict')
const test = require('node:test')
const { generateSeed, seedFakerWithPriority } = require('../app/faker/faker-seed-entity')
const { createOrganisationProfile, mapOrganisationFields } = require('../app/faker/organisation-profile')
const documentMapper = require('../app/faker/map-document-org-faker')
const paymentMapper = require('../app/faker/map-payment-org-faker')

test('organisation seeds normalise identifier representations and prefer FRN', () => {
  const seeds = []
  const faker = { seed: seed => seeds.push(seed) }
  assert.equal(generateSeed(100000001), generateSeed(' 100000001 '))
  assert.deepEqual(seedFakerWithPriority(faker, { frn: '100000001', sbi: '200000001' }), {
    seed: generateSeed('100000001'),
    usedProperty: 'frn'
  })
  assert.equal(seeds.length, 1)
  assert.equal(seedFakerWithPriority(faker, { frn: ' ', sbi: '200000001' }).usedProperty, 'sbi')
  assert.throws(() => seedFakerWithPriority(faker, { frn: null, sbi: '' }), /non-empty frn or sbi/)
})

test('organisation profiles are repeatable independently of processing order', () => {
  const organisation = { frn: '100000001', sbi: '200000001' }
  const profile = createOrganisationProfile(organisation)
  createOrganisationProfile({ frn: '100000002' })
  assert.deepEqual(createOrganisationProfile(organisation), profile)
  assert.deepEqual(createOrganisationProfile({ frn: 100000001 }), profile)
  assert.notDeepEqual(createOrganisationProfile({ frn: '100000002' }), profile)
  assert.match(profile.emailAddress, /@example\.com$/)
  assert.equal(Object.hasOwn(profile, 'phoneNumber'), false)
})

test('document mapper changes only configured fields and does not mutate its input', () => {
  const organisation = {
    frn: '100000001',
    sbi: '200000001',
    name: 'Original organisation',
    addressLine1: 'Original address',
    addressLine2: 'Original district',
    addressLine3: 'Original locality',
    city: 'Original city',
    county: 'Original county',
    postcode: 'AA1 1AA',
    emailAddress: 'original@example.invalid',
    phoneNumber: '01234 567890',
    updated: '2026-01-01',
    published: false,
    amount: 12345,
    metadata: { unchanged: true }
  }
  const original = structuredClone(organisation)
  const result = documentMapper.anonymizeOrganisation(organisation)
  const profile = createOrganisationProfile(organisation)

  for (const [column, value] of Object.entries(organisation)) {
    if (Object.hasOwn(documentMapper.FIELD_MAP, column)) {
      assert.equal(result[column], profile[documentMapper.FIELD_MAP[column]])
      assert.notEqual(result[column], value)
    } else {
      assert.deepEqual(result[column], value)
    }
  }
  assert.deepEqual(organisation, original)
})

test('document mapper preserves null, empty and absent fields', () => {
  const organisation = { frn: '100000001', name: null, addressLine1: '', addressLine2: ' ', emailAddress: null }
  assert.deepEqual(documentMapper.anonymizeOrganisation(organisation), organisation)
  assert.throws(() => documentMapper.anonymizeOrganisation({ name: 'Missing identifiers' }), /non-empty/)
})

test('different column mappings use the same complete fictional profile', () => {
  const document = documentMapper.anonymizeOrganisation({ frn: '100000001', name: 'Original', city: 'Original' })
  const payment = mapOrganisationFields({ frn: '100000001', organisationName: 'Original' }, { organisationName: 'name' })
  assert.equal(payment.organisationName, document.name)
  assert.throws(() => mapOrganisationFields({ frn: '100000001' }, { name: 'notAProfileField' }), /Unknown organisation profile field/)
})

test('payment mapping template is inactive and leaves all data unchanged', () => {
  const organisation = { name: 'Original', address: 'Original', amount: 12345 }
  assert.deepEqual(paymentMapper.FIELD_MAP, {})
  assert.deepEqual(paymentMapper.anonymizeOrganisation(organisation), organisation)
  assert.notEqual(paymentMapper.anonymizeOrganisation(organisation), organisation)
})
