import mongoose from 'mongoose';

const dailyStatusSchema = new mongoose.Schema({
  strategy: { type: String, default: 'TRAFFIC_LIGHT' },
  date: { type: String, required: true, unique: true },
  tradeTakenToday: { type: Boolean, default: false },
  breakoutHigh: { type: Number, default: null },
  breakoutLow: { type: Number, default: null }
});

export const DailyStatus = mongoose.models.DailyStatus ||
  mongoose.model('DailyStatus', dailyStatusSchema);
