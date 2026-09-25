'use strict';

// Explicit test/demo fixture only. Production FarmStore never imports or seeds it.
const facility = Object.freeze({ name: 'Isolated Test Farm', ownerName: 'Test Owner', address: '100 Test Lane', emergencyPhone: '555-0100', waterSource: 'Municipal' });
const lot = Object.freeze({ harvestDate: '2026-09-23', room: 'Room A', species: 'Pleurotus ostreatus', quantityLbs: '48.000', notes: 'Test harvest' });
const customer = Object.freeze({ name: 'Test Recipient', contact: 'Receiving', email: 'receiving@example.invalid', phone: '555-0101', address: '200 Test Lane' });
const sourceSnapshot = Object.freeze({ id: 'legacy-fixture-1', block: 'BLOCK-A', n: 2, date: '2026-09-22', weight: 47.25, grade: 'A', notes: '  Original source note  ', createdAt: '2026-09-22T10:00:00.000Z', updatedAt: '2026-09-23T10:00:00.000Z' });
function seed(store) {
  const savedFacility = store.handle('facility.save', { ...facility });
  const firstLot = store.handle('lot.adopt', { ...lot, sourceId: 'legacy-flush:' + sourceSnapshot.id, sourceSnapshot: { ...sourceSnapshot } });
  const secondLot = store.handle('lot.create', { ...lot, room: 'Room B', quantityLbs: '30.000' });
  const recipient = store.handle('customer.create', { ...customer });
  return { facility: savedFacility, firstLot, secondLot, customer: recipient };
}
module.exports = { facility, lot, customer, sourceSnapshot, seed };
