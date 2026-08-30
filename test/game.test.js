const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../game');

function ws(id) { return { id, readyState: 1, messages: [], send(message) { this.messages.push(JSON.parse(message)); } }; }

function roomWithHumanDealer() {
    const dealerWs = ws('dealer');
    const playerWs = ws('player');
    return {
        code: 'TEST', status: 'resolved', dealerType: 'dealer', dealerLiability: 300,
        dealerHand: [{ value: 10, name: 'king' }, { value: 7, name: '7' }], deck: [], currentPlayerIndex: 0, roundPlayerIds: ['player'],
        players: [
            { id: 'dealer', name: 'Croupier', chips: 1000, pendingBet: 0, hands: [], currentHandIndex: 0, ws: dealerWs },
            { id: 'player', name: 'Joueur', chips: 900, pendingBet: 0, currentHandIndex: 0, ws: playerWs, hands: [{ cards: [{ value: 11, name: 'ace' }, { value: 10, name: 'king' }], bet: 100, status: 'blackjack' }] }
        ]
    };
}

test('un blackjack paie exactement 3/2 de gain net et est debite au croupier', () => {
    const room = roomWithHumanDealer();
    game.resolveRound(room);
    assert.equal(room.players[1].chips, 1150);
    assert.equal(room.players[0].chips, 850);
    assert.equal(room.players[1].lastReward, 150);
});

test('la banque impose un plafond qui couvre tous les blackjacks simultanes', () => {
    const room = roomWithHumanDealer();
    room.status = 'waiting';
    room.players.push({ id: 'other', name: 'Autre', chips: 1000, pendingBet: 0, hands: [], currentHandIndex: 0, ws: ws('other') });
    assert.equal(game.maxBetPerPlayer(room), 100);
});

test('une mise est immobilisee et ne peut pas depasser la reserve du croupier', () => {
    const rooms = {};
    const dealerWs = ws('dealer');
    const playerWs = ws('player');
    game.createRoom(rooms, dealerWs, 'Croupier', 300);
    const room = Object.values(rooms)[0];
    game.joinRoom(rooms, playerWs, room.code, 'Joueur', 1_000);
    game.setDealerMode(room, dealerWs, 300);
    game.setPlayerBet(room, playerWs, 200);
    assert.equal(room.players.find(player => player.id === 'player').pendingBet, 200);
    assert.equal(room.players.find(player => player.id === 'player').chips, 800);
    game.setPlayerBet(room, playerWs, 201);
    assert.equal(room.players.find(player => player.id === 'player').pendingBet, 200);
    assert.equal(playerWs.messages.at(-1).action, 'error');
});

test('un blackjack sur une mise impaire conserve le demi-jeton', () => {
    const room = roomWithHumanDealer();
    room.players[1].chips = 999;
    room.players[1].hands[0].bet = 1;
    game.resolveRound(room);
    assert.equal(room.players[1].chips, 1001.5);
    assert.equal(room.players[0].chips, 998.5);
});

test('un joueur ruine est renfloue a 100 T apres le reglement', () => {
    const room = roomWithHumanDealer();
    room.players[1].chips = 0;
    room.players[1].hands[0] = { cards: [{ value: 10, name: 'king' }, { value: 10, name: 'queen' }, { value: 5, name: '5' }], bet: 100, status: 'busted' };
    game.resolveRound(room);
    assert.equal(room.players[1].chips, 100);
});
