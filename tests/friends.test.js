const { registerAndLogin, findUserId } = require('./helpers');

function extractRequestId(html) {
  const match = html.match(/\/friends\/requests\/(\d+)\/accept/);
  return match ? match[1] : null;
}

describe('friends', () => {
  test('sending a friend request shows it on the recipient\'s requests page', async () => {
    const alice = await registerAndLogin({ username: 'alice' });
    const bob = await registerAndLogin({ username: 'bob' });
    const bobId = await findUserId(alice.agent, 'bob');

    const sendRes = await alice.agent.post(`/friends/request/${bobId}`);
    expect(sendRes.status).toBe(302);

    const requestsPage = await bob.agent.get('/friends/requests');
    expect(requestsPage.text).toContain('alice');
  });

  test('accepting a request makes both users friends', async () => {
    const alice = await registerAndLogin({ username: 'carol' });
    const bob = await registerAndLogin({ username: 'dan' });
    const bobId = await findUserId(alice.agent, 'dan');

    await alice.agent.post(`/friends/request/${bobId}`);
    const requestsPage = await bob.agent.get('/friends/requests');
    const requestId = extractRequestId(requestsPage.text);

    const accept = await bob.agent.post(`/friends/requests/${requestId}/accept`);
    expect(accept.status).toBe(302);

    const aliceFriends = await alice.agent.get('/friends');
    const bobFriends = await bob.agent.get('/friends');
    expect(aliceFriends.text).toContain('dan');
    expect(bobFriends.text).toContain('carol');
  });

  test('declining a request removes it without creating a friendship', async () => {
    const alice = await registerAndLogin({ username: 'erin' });
    const bob = await registerAndLogin({ username: 'finn' });
    const bobId = await findUserId(alice.agent, 'finn');

    await alice.agent.post(`/friends/request/${bobId}`);
    const requestsPage = await bob.agent.get('/friends/requests');
    const requestId = extractRequestId(requestsPage.text);
    await bob.agent.post(`/friends/requests/${requestId}/decline`);

    const bobFriends = await bob.agent.get('/friends');
    expect(bobFriends.text).not.toContain('erin');

    const bobRequests = await bob.agent.get('/friends/requests');
    expect(bobRequests.text).not.toContain('erin');
  });

  test('unfriending removes the friendship for both users', async () => {
    const alice = await registerAndLogin({ username: 'gina' });
    const bob = await registerAndLogin({ username: 'hank' });
    const bobId = await findUserId(alice.agent, 'hank');

    await alice.agent.post(`/friends/request/${bobId}`);
    const requestsPage = await bob.agent.get('/friends/requests');
    const requestId = extractRequestId(requestsPage.text);
    await bob.agent.post(`/friends/requests/${requestId}/accept`);

    await alice.agent.post(`/users/${bobId}/unfriend`);

    const aliceFriends = await alice.agent.get('/friends');
    const bobFriends = await bob.agent.get('/friends');
    expect(aliceFriends.text).not.toContain('hank');
    expect(bobFriends.text).not.toContain('gina');
  });

  test('sending a request to someone who already requested you accepts it instead of duplicating', async () => {
    const alice = await registerAndLogin({ username: 'iris' });
    const bob = await registerAndLogin({ username: 'jack' });
    const bobId = await findUserId(alice.agent, 'jack');
    const aliceId = await findUserId(bob.agent, 'iris');

    await alice.agent.post(`/friends/request/${bobId}`); // alice -> bob
    await bob.agent.post(`/friends/request/${aliceId}`); // bob -> alice, should auto-accept

    const aliceFriends = await alice.agent.get('/friends');
    expect(aliceFriends.text).toContain('jack');

    const bobRequests = await bob.agent.get('/friends/requests');
    expect(bobRequests.text).not.toContain('Respond');
  });

  test('you cannot accept a friend request that was not sent to you', async () => {
    const alice = await registerAndLogin({ username: 'kate' });
    const bob = await registerAndLogin({ username: 'liam' });
    const eve = await registerAndLogin({ username: 'eve' });
    const bobId = await findUserId(alice.agent, 'liam');

    await alice.agent.post(`/friends/request/${bobId}`);
    const requestsPage = await bob.agent.get('/friends/requests');
    const requestId = extractRequestId(requestsPage.text);

    await eve.agent.post(`/friends/requests/${requestId}/accept`);

    const eveFriends = await eve.agent.get('/friends');
    expect(eveFriends.text).not.toContain('kate');
    expect(eveFriends.text).not.toContain('liam');
  });
});
