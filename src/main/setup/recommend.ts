import type { MachineProfile, Recommendation } from '@shared/setup';
import { recommendChatModel, recommendEmbeddingModel } from '../models/catalog';

export function recommendForMachine(profile: MachineProfile): Recommendation {
  return {
    chatModel: recommendChatModel(profile.ramGb),
    embeddingModel: recommendEmbeddingModel(),
  };
}
