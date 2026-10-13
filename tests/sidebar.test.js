const sidebar = require('../src/services/sidebarService');

describe('sidebarService', () => {
  test('returns empty lists when there is no user', () => {
    expect(sidebar.get(0)).toEqual({ trends: [], popular: [], people: [] });
  });

  test('returns arrays for a user id', () => {
    const r = sidebar.get(999999);
    expect(Array.isArray(r.trends)).toBe(true);
    expect(Array.isArray(r.popular)).toBe(true);
    expect(Array.isArray(r.people)).toBe(true);
  });

  test('lazyFor computes once and tolerates a missing user', () => {
    const get = sidebar.lazyFor(null);
    expect(get()).toBe(get());
  });
});
