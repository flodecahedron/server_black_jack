const { createDeck, shuffle, calculateScore } = require('./deck');

// Le serveur est l'unique autorite pour les jetons. `chips` est le solde
// disponible : une mise est retiree au moment ou elle est posee puis rendue
// (avec le gain eventuel) au reglement.
const MAX_PLAYERS = 4;
const BLACKJACK_PAYOUT = 1.5;

function generateRoomCode(rooms) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms[code]);
    return code;
}

function sendError(ws, message) {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ action: 'error', message }));
}

function playerById(room, id) { return room.players.find(player => player.id === id); }
function dealerPlayer(room) { return room.dealerType === 'AI' ? null : playerById(room, room.dealerType); }
function opponentCount(room) { return room.players.filter(player => player.id !== room.dealerType).length; }

function maxBetPerPlayer(room) {
    const dealer = dealerPlayer(room);
    const count = opponentCount(room);
    if (!dealer || count === 0) return 0;
    // Tous les adversaires peuvent faire blackjack simultanement : 3/2 de gain par mise.
    return Math.floor((2 * room.dealerLiability) / (3 * count));
}

function maskedDealerHand(room, viewerId) {
    const revealed = room.status === 'dealer_turn' || room.status === 'resolved' || room.dealerType === viewerId;
    return room.dealerHand.map((card, index) => index === 1 && !revealed ? { text: 'back', hidden: true } : card);
}

function getSanitizedState(room, viewerId = null) {
    const dealer = dealerPlayer(room);
    return {
        code: room.code,
        status: room.status,
        dealerType: room.dealerType === 'AI' ? 'AI' : 'PLAYER',
        dealerName: dealer?.name || 'Ordinateur',
        dealerHand: maskedDealerHand(room, viewerId),
        dealerScore: room.status === 'dealer_turn' || room.status === 'resolved' || room.dealerType === viewerId ? calculateScore(room.dealerHand) : 0,
        currentPlayerId: room.roundPlayerIds[room.currentPlayerIndex] || null,
        roundNumber: room.roundNumber,
        dealerLiability: room.dealerLiability,
        maxBetPerPlayer: maxBetPerPlayer(room),
        players: room.players.map(player => ({
            id: player.id,
            name: player.name,
            isYou: player.id === viewerId,
            isDealer: player.id === room.dealerType,
            hands: player.hands.map(hand => ({ cards: hand.cards, score: calculateScore(hand.cards), bet: hand.bet, status: hand.status })),
            currentHandIndex: player.currentHandIndex,
            chips: player.chips,
            pendingBet: player.pendingBet,
            lastOutcome: player.lastOutcome || null,
            lastReward: player.lastReward || 0
        }))
    };
}

function broadcastToRoom(room, action = 'update_table') {
    if (!room) return;
    room.players.forEach(player => {
        if (player.ws.readyState === 1) player.ws.send(JSON.stringify({ action, state: getSanitizedState(room, player.id) }));
    });
}

function createRoom(rooms, ws, playerName, chips) {
    const code = generateRoomCode(rooms);
    rooms[code] = { code, status: 'waiting', dealerType: 'AI', dealerLiability: 0, dealerHand: [], deck: [], currentPlayerIndex: 0, roundPlayerIds: [], roundNumber: 0, players: [] };
    joinRoom(rooms, ws, code, playerName, chips);
}

function joinRoom(rooms, ws, roomCode, playerName, chips) {
    const code = String(roomCode || '').toUpperCase();
    const room = rooms[code];
    if (!room) return sendError(ws, 'Table introuvable.');
    if (room.status !== 'waiting') return sendError(ws, 'La manche est deja en cours.');
    if (room.players.length >= MAX_PLAYERS) return sendError(ws, 'Table pleine.');
    const name = String(playerName || 'Joueur').trim().slice(0, 24) || 'Joueur';
    if (room.players.some(player => player.name === name)) return sendError(ws, 'Ce pseudo est deja utilise a cette table.');

    const safeChips = Number.isFinite(chips) && chips >= 0 ? chips : 1000;
    ws.roomCode = code;
    room.players.push({ id: ws.id, name, chips: safeChips, pendingBet: 0, hands: [], currentHandIndex: 0, lastOutcome: null, lastReward: 0, ws });
    ws.send(JSON.stringify({ action: 'room_joined', room_code: code }));
    broadcastToRoom(room);
}

function setDealerMode(room, ws, liabilityLimit) {
    if (!room || room.status !== 'waiting') return sendError(ws, 'Le croupier ne peut changer qu entre les manches.');
    const player = playerById(room, ws.id);
    if (!player) return;
    if (room.dealerType === ws.id) {
        room.dealerType = 'AI';
        room.dealerLiability = 0;
        return broadcastToRoom(room);
    }
    const limit = Number(liabilityLimit);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > player.chips) return sendError(ws, 'La banque doit etre un montant entier compris entre 1 et votre solde disponible.');

    // Un croupier ne joue jamais aussi contre sa propre banque.
    player.chips += player.pendingBet;
    player.pendingBet = 0;
    room.dealerType = ws.id;
    room.dealerLiability = limit;
    broadcastToRoom(room);
}

function setDealerLiability(room, ws, liabilityLimit) {
    if (!room || room.status !== 'waiting' || room.dealerType !== ws.id) return;
    const dealer = playerById(room, ws.id);
    const limit = Number(liabilityLimit);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > dealer.chips) return sendError(ws, 'Banque invalide.');
    const oldLimit = room.dealerLiability;
    room.dealerLiability = limit;
    if (room.players.some(player => player.pendingBet > maxBetPerPlayer(room))) {
        room.dealerLiability = oldLimit;
        return sendError(ws, 'Cette banque est inferieure aux mises deja posees.');
    }
    broadcastToRoom(room);
}

function setPlayerBet(room, ws, amount) {
    if (!room || room.status !== 'waiting') return sendError(ws, 'Les mises sont fermees.');
    const player = playerById(room, ws.id);
    if (!player || player.id === room.dealerType) return sendError(ws, 'Le croupier ne mise pas contre sa propre banque.');
    const bet = Number(amount);
    if (!Number.isSafeInteger(bet) || bet < 0) return sendError(ws, 'Mise invalide.');
    if (bet > player.chips + player.pendingBet) return sendError(ws, 'Jetons insuffisants.');
    if (room.dealerType !== 'AI' && bet > maxBetPerPlayer(room)) return sendError(ws, `Mise maximale : ${maxBetPerPlayer(room)} T.`);

    player.chips += player.pendingBet;
    player.chips -= bet;
    player.pendingBet = bet;
    broadcastToRoom(room);
}

function startRound(room, ws) {
    if (!room) return;
    // Une manche réglée revient d'abord à la phase de mises. Cela évite qu'un
    // clic sur « Nouvelle manche » soit silencieusement ignoré.
    if (room.status === 'resolved') {
        room.status = 'waiting';
        room.players.forEach(player => {
            player.hands = [];
            player.currentHandIndex = 0;
            player.lastOutcome = null;
            player.lastReward = 0;
        });
        return broadcastToRoom(room);
    }
    if (room.status !== 'waiting') return;
    const starters = room.players.filter(player => player.id !== room.dealerType && player.pendingBet > 0);
    if (starters.length === 0) return sendError(ws, 'Au moins un joueur doit poser une mise.');
    const dealer = dealerPlayer(room);
    if (dealer) {
        const worstCase = starters.reduce((sum, player) => sum + player.pendingBet * BLACKJACK_PAYOUT, 0);
        if (dealer.chips < worstCase || room.dealerLiability < worstCase) return sendError(ws, 'La banque ne couvre plus tous les blackjacks possibles.');
    }

    room.status = 'playing';
    room.roundNumber++;
    room.deck = shuffle(createDeck());
    room.dealerHand = [room.deck.pop(), room.deck.pop()];
    room.roundPlayerIds = starters.map(player => player.id);
    room.currentPlayerIndex = 0;
    room.players.forEach(player => {
        player.hands = [];
        player.currentHandIndex = 0;
        player.lastOutcome = null;
        player.lastReward = 0;
        if (room.roundPlayerIds.includes(player.id)) {
            const hand = { cards: [room.deck.pop(), room.deck.pop()], bet: player.pendingBet, status: 'playing' };
            player.pendingBet = 0;
            if (isBlackjack(hand.cards)) hand.status = 'blackjack';
            player.hands = [hand];
        }
    });
    advanceToPlayableHand(room);
}

function isBlackjack(cards) { return cards.length === 2 && calculateScore(cards) === 21; }
function currentPlayer(room) { return playerById(room, room.roundPlayerIds[room.currentPlayerIndex]); }

function canReserveAdditionalBet(room, player, amount) {
    if (amount > player.chips) return false;
    const dealer = dealerPlayer(room);
    if (!dealer) return true;
    const allBets = room.roundPlayerIds.reduce((sum, id) => sum + playerById(room, id).hands.reduce((total, hand) => total + hand.bet, 0), 0) + amount;
    const worstCase = allBets * BLACKJACK_PAYOUT;
    return worstCase <= room.dealerLiability && worstCase <= dealer.chips;
}

function handleHit(room, ws) {
    if (!room || room.status !== 'playing') return;
    const player = currentPlayer(room);
    if (!player || player.id !== ws.id) return;
    const hand = player.hands[player.currentHandIndex];
    hand.cards.push(room.deck.pop());
    if (calculateScore(hand.cards) > 21) hand.status = 'busted';
    advanceToPlayableHand(room);
}

function handleDouble(room, ws) {
    if (!room || room.status !== 'playing') return;
    const player = currentPlayer(room);
    if (!player || player.id !== ws.id) return;
    const hand = player.hands[player.currentHandIndex];
    if (hand.cards.length !== 2 || hand.status !== 'playing') return;
    if (!canReserveAdditionalBet(room, player, hand.bet)) return sendError(ws, 'Double impossible : solde ou banque insuffisant.');
    player.chips -= hand.bet;
    hand.bet *= 2;
    hand.cards.push(room.deck.pop());
    hand.status = calculateScore(hand.cards) > 21 ? 'busted' : 'doubled';
    advanceToPlayableHand(room);
}

function handleSplit(room, ws) {
    if (!room || room.status !== 'playing') return;
    const player = currentPlayer(room);
    if (!player || player.id !== ws.id) return;
    const hand = player.hands[player.currentHandIndex];
    if (player.hands.length !== 1 || hand.cards.length !== 2 || hand.cards[0].value !== hand.cards[1].value) return sendError(ws, 'Le split requiert deux cartes de meme valeur.');
    if (!canReserveAdditionalBet(room, player, hand.bet)) return sendError(ws, 'Split impossible : solde ou banque insuffisant.');

    player.chips -= hand.bet;
    const splitCard = hand.cards.pop();
    hand.cards.push(room.deck.pop());
    player.hands.push({ cards: [splitCard, room.deck.pop()], bet: hand.bet, status: 'playing' });
    advanceToPlayableHand(room);
}

function handleStand(room, ws) {
    if (!room || room.status !== 'playing') return;
    const player = currentPlayer(room);
    if (!player || player.id !== ws.id) return;
    player.hands[player.currentHandIndex].status = 'stood';
    advanceToPlayableHand(room);
}

function advanceToPlayableHand(room) {
    let player = currentPlayer(room);
    while (player) {
        const hand = player.hands[player.currentHandIndex];
        if (hand?.status === 'playing') return broadcastToRoom(room);
        if (player.currentHandIndex < player.hands.length - 1) { player.currentHandIndex++; continue; }
        room.currentPlayerIndex++;
        player = currentPlayer(room);
    }
    runDealerTurn(room);
}

function runDealerTurn(room) {
    if (room.dealerType !== 'AI') {
        room.status = 'dealer_turn';
        return broadcastToRoom(room);
    }
    while (calculateScore(room.dealerHand) < 17) room.dealerHand.push(room.deck.pop());
    resolveRound(room);
}

function handleDealerHit(room, ws) {
    if (!room || room.status !== 'dealer_turn' || room.dealerType !== ws.id) return;
    room.dealerHand.push(room.deck.pop());
    if (calculateScore(room.dealerHand) > 21) resolveRound(room);
    else broadcastToRoom(room);
}
function handleDealerStand(room, ws) { if (room?.status === 'dealer_turn' && room.dealerType === ws.id) resolveRound(room); }

function handOutcome(hand, dealerHand) {
    const playerScore = calculateScore(hand.cards);
    const dealerScore = calculateScore(dealerHand);
    if (playerScore > 21) return 'lose';
    if (isBlackjack(hand.cards) && !isBlackjack(dealerHand)) return 'blackjack';
    if (dealerScore > 21 || playerScore > dealerScore) return 'win';
    if (playerScore < dealerScore) return 'lose';
    return 'push';
}

function resolveRound(room) {
    room.status = 'resolved';
    const dealer = dealerPlayer(room);
    let dealerReward = 0;
    room.roundPlayerIds.forEach(id => {
        const player = playerById(room, id);
        if (!player) return;
        let netReward = 0;
        const outcomes = [];
        player.hands.forEach(hand => {
            const outcome = handOutcome(hand, room.dealerHand);
            outcomes.push(outcome);
            if (outcome === 'push') player.chips += hand.bet;
            else if (outcome === 'blackjack') {
                const payout = hand.bet * (1 + BLACKJACK_PAYOUT);
                player.chips += payout;
                netReward += payout - hand.bet;
                dealerReward -= payout - hand.bet;
            } else if (outcome === 'win') {
                player.chips += hand.bet * 2;
                netReward += hand.bet;
                dealerReward -= hand.bet;
            } else {
                netReward -= hand.bet;
                dealerReward += hand.bet;
            }
        });
        player.lastOutcome = netReward > 0 ? 'win' : netReward < 0 ? 'lose' : 'push';
        player.lastReward = netReward;
    });
    if (dealer) {
        dealer.chips += dealerReward;
        dealer.lastOutcome = dealerReward > 0 ? 'win' : dealerReward < 0 ? 'lose' : 'push';
        dealer.lastReward = dealerReward;
    }

    // La table reste jouable après une faillite : le renflouement est appliqué
    // uniquement à la fin d'une manche, une fois tous les gains réglés.
    room.players.forEach(player => {
        if (player.chips <= 0) player.chips = 100;
    });
    broadcastToRoom(room);
}

function handleDisconnect(rooms, ws) {
    const room = rooms[ws.roomCode];
    if (!room) return;
    room.players = room.players.filter(player => player.id !== ws.id);
    room.roundPlayerIds = room.roundPlayerIds.filter(id => id !== ws.id);
    if (room.dealerType === ws.id) { room.dealerType = 'AI'; room.dealerLiability = 0; }
    if (room.players.length === 0) delete rooms[ws.roomCode];
    else if (room.status === 'playing' && !currentPlayer(room)) runDealerTurn(room);
    else broadcastToRoom(room);
}

module.exports = { BLACKJACK_PAYOUT, createRoom, joinRoom, setDealerMode, setDealerLiability, setPlayerBet, startRound, handleHit, handleStand, handleDouble, handleSplit, handleDealerHit, handleDealerStand, handleDisconnect, getSanitizedState, broadcastToRoom, maxBetPerPlayer, resolveRound };
