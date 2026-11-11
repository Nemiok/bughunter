afterEach(() => { throw new Error('teardown hook exploded'); });

test('teardown hook assertion', () => { expect(1).toBe(1); });
