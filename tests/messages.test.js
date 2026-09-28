const { registerAndLogin, findUserId } = require('./helpers');

function extractMessageId(html) {
  const match = html.match(/data-id="(\d+)"/);
  return match ? match[1] : null;
}

describe('messages', () => {
  test('a sent message appears in the recipient\'s chat view', async () => {
    const alice = await registerAndLogin({ username: 'alice' });
    const bob = await registerAndLogin({ username: 'bob' });
    const bobId = await findUserId(alice.agent, 'bob');
    const aliceId = await findUserId(bob.agent, 'alice');

    await alice.agent.post(`/messages/${bobId}`).type('form').send({ body: 'hello bob' });

    const chat = await bob.agent.get(`/messages/${aliceId}`);
    expect(chat.text).toContain('hello bob');
  });

  test('an empty message with no image is not sent', async () => {
    const alice = await registerAndLogin({ username: 'carol' });
    const bob = await registerAndLogin({ username: 'dan' });
    const bobId = await findUserId(alice.agent, 'dan');
    const aliceId = await findUserId(bob.agent, 'carol');

    await alice.agent.post(`/messages/${bobId}`).type('form').send({ body: '   ' });

    const chat = await bob.agent.get(`/messages/${aliceId}`);
    expect(chat.text).not.toMatch(/data-id="\d+"/);
  });

  test('a message over the length limit is rejected', async () => {
    const alice = await registerAndLogin({ username: 'erin' });
    const bob = await registerAndLogin({ username: 'finn' });
    const bobId = await findUserId(alice.agent, 'finn');

    const tooLong = 'a'.repeat(2001);
    await alice.agent.post(`/messages/${bobId}`).type('form').send({ body: tooLong });

    const chat = await alice.agent.get(`/messages/${bobId}`);
    expect(chat.text).not.toContain(tooLong);
  });

  test('editing your own message updates its text and marks it edited', async () => {
    const alice = await registerAndLogin({ username: 'gina' });
    const bob = await registerAndLogin({ username: 'hank' });
    const bobId = await findUserId(alice.agent, 'hank');

    await alice.agent.post(`/messages/${bobId}`).type('form').send({ body: 'original text' });
    const chatBefore = await alice.agent.get(`/messages/${bobId}`);
    const messageId = extractMessageId(chatBefore.text);

    await alice.agent
      .post(`/messages/${bobId}/${messageId}/edit`)
      .type('form')
      .send({ body: 'edited text' });

    const chat = await alice.agent.get(`/messages/${bobId}`);
    expect(chat.text).toContain('edited text');
    expect(chat.text).not.toContain('original text');
    expect(chat.text).toContain('edited)');
  });

  test('a user cannot edit someone else\'s message', async () => {
    const alice = await registerAndLogin({ username: 'iris' });
    const bob = await registerAndLogin({ username: 'jack' });
    const bobId = await findUserId(alice.agent, 'jack');
    const aliceId = await findUserId(bob.agent, 'iris');

    await alice.agent.post(`/messages/${bobId}`).type('form').send({ body: 'original text' });
    const chatBefore = await alice.agent.get(`/messages/${bobId}`);
    const messageId = extractMessageId(chatBefore.text);

    await bob.agent
      .post(`/messages/${aliceId}/${messageId}/edit`)
      .type('form')
      .send({ body: 'hacked' });

    const chat = await alice.agent.get(`/messages/${bobId}`);
    expect(chat.text).toContain('original text');
    expect(chat.text).not.toContain('hacked');
  });

  test('deleting your own message replaces it with a placeholder', async () => {
    const alice = await registerAndLogin({ username: 'kate' });
    const bob = await registerAndLogin({ username: 'liam' });
    const bobId = await findUserId(alice.agent, 'liam');
    const aliceId = await findUserId(bob.agent, 'kate');

    await alice.agent.post(`/messages/${bobId}`).type('form').send({ body: 'to be deleted' });
    const chatBefore = await alice.agent.get(`/messages/${bobId}`);
    const messageId = extractMessageId(chatBefore.text);

    await alice.agent.post(`/messages/${bobId}/${messageId}/delete`);

    const chat = await bob.agent.get(`/messages/${aliceId}`);
    expect(chat.text).not.toContain('to be deleted');
    expect(chat.text).toContain('Message deleted');
  });

  test('a user cannot delete someone else\'s message', async () => {
    const alice = await registerAndLogin({ username: 'mona' });
    const bob = await registerAndLogin({ username: 'nate' });
    const bobId = await findUserId(alice.agent, 'nate');
    const aliceId = await findUserId(bob.agent, 'mona');

    await alice.agent.post(`/messages/${bobId}`).type('form').send({ body: 'keep me' });
    const chatBefore = await alice.agent.get(`/messages/${bobId}`);
    const messageId = extractMessageId(chatBefore.text);

    await bob.agent.post(`/messages/${aliceId}/${messageId}/delete`);

    const chat = await alice.agent.get(`/messages/${bobId}`);
    expect(chat.text).toContain('keep me');
  });
});
