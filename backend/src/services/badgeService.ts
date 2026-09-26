import { LEVEL_THRESHOLDS, BADGE_NAMES, BADGE_DESCRIPTIONS, Badge } from '../types';
import { PoolClient } from 'pg';
import pool from '../db/pool';

export const calculateLevel = (totalPoints: number): number => {
  let currentLevel = 1;
  for (let level = 5; level >= 1; level--) {
    if (totalPoints >= LEVEL_THRESHOLDS[level]) {
      currentLevel = level;
      break;
    }
  }
  return currentLevel;
};

export const checkNewBadges = async (
  volunteerId: string,
  newLevel: number,
  currentBadges: Badge[],
  client?: PoolClient
): Promise<Badge[]> => {
  const newBadges: Badge[] = [];
  const currentLevels = currentBadges.map(b => b.star_level);

  const queryRunner = client ?? pool;

  for (let level = 2; level <= newLevel; level++) {
    if (!currentLevels.includes(level)) {
      const badgeName = BADGE_NAMES[level];
      const description = BADGE_DESCRIPTIONS[level];

      const result = await queryRunner.query(
        `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (volunteer_id, star_level) DO NOTHING
         RETURNING *`,
        [volunteerId, level, badgeName, description]
      );
      if (result.rows[0]) {
        newBadges.push(result.rows[0]);
      }
    }
  }

  return newBadges;
};

export const getVolunteerBadges = async (volunteerId: string): Promise<Badge[]> => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM badges WHERE volunteer_id = $1 ORDER BY star_level',
      [volunteerId]
    );
    return result.rows;
  } finally {
    client.release();
  }
};

export { LEVEL_THRESHOLDS, BADGE_NAMES };
