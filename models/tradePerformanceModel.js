import mongoose from 'mongoose';

// ⚠️  IMPORTANT — shared collection note:
// Both trafficTradePerformanceModel and condorTradePerformanceModel register
// a model named 'TradePerformance' on the same collection.
// Mongoose caches models by name — whichever imports first wins.
// Both schemas are kept identical so the cached model works for both strategies.
// The 'strategy' field ('TRAFFIC_LIGHT' | 'IRON_CONDOR') differentiates records.

const tradePerformanceSchema = new mongoose.Schema({
    strategy: {
        type:    String,
        default: 'TRAFFIC_LIGHT',
        enum:    ['TRAFFIC_LIGHT', 'IRON_CONDOR'],
    },

    index: { type: String, required: true },

    // activeTradeId is Iron Condor specific — null for traffic light trades
    activeTradeId: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'ActiveTrade',
        default: null,
    },

    // ✅ FIX: FIREFIGHT added to match condorTradePerformanceModel enum exactly.
    exitReason: {
        type: String,
        enum: [
            'STOP_LOSS_HIT',
            'PROFIT_TARGET',
            'MANUAL_CLOSE',
            'FIREFIGHT',
            'ATM_MANUAL_HANDOFF',
        ],
    },

    realizedPnL: { type: Number, required: true },

    // Null for traffic light trades — only populated by condor firefight exits
    firefightBookedPnL: { type: Number, default: null },

    notes: { type: String },

}, { timestamps: true });

// Named getter for lazy/safe access pattern
export const getTrafficTradePerformanceModel = () =>
    mongoose.models.TradePerformance ||
    mongoose.model('TradePerformance', tradePerformanceSchema);

// ✅ FIX: Default export is a resolved model instance (not a getter function).
// traficLightEngine calls TrafficTradePerformance.create({...}) directly.
// Previously changed to a getter function () => model which broke .create() calls.
const TrafficTradePerformance = getTrafficTradePerformanceModel();
export default TrafficTradePerformance;