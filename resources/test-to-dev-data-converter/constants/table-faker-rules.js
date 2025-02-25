module.exports = {
  tables: {
    Faker: {
      columns: [
        { name: 'name', faker: 'person.fullName' },
        { name: 'address_line_1', faker: 'location.streetAddress' },
        { name: 'address_line_2', faker: 'location.secondaryAddress' },
        { name: 'address_line_3', faker: 'location.city' },
        { name: 'address_line_4', faker: 'location.county' },
        { name: 'postcode', faker: 'location.zipCode' },
        { name: 'phone_number', faker: 'phone.number' }
      ]
    }
    // fill this out with the tables requiring faker rules
  }
}
