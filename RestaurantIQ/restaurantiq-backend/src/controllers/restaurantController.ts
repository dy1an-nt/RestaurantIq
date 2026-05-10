import { Request, Response } from 'express';
import { supabase } from '../db';

interface AuthRequest extends Request {
  user?: any;
}

export const createRestaurant = async (req: AuthRequest, res: Response) => {
  try {
    const { name, location, pos_connected, delivery_connected, square_location_id, doordash_store_id } = req.body;
    const userId = req.user?.sub; // Supabase user id from JWT
    if (!userId) {
      return res.status(401).json({ data: null, error: 'Missing user id on token' });
    }

    // Guard against double-create (network retries, double-click).
    const { data: existing } = await supabase
      .from('restaurants')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({ data: null, error: 'A restaurant already exists for this account' });
    }

    const { data, error } = await supabase
      .from('restaurants')
      .insert({
        user_id: userId,
        name,
        location,
        pos_connected: pos_connected || false,
        delivery_connected: delivery_connected || false,
        square_location_id: square_location_id ?? null,
        doordash_store_id: doordash_store_id ?? null,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ data: null, error: 'A restaurant already exists for this account' });
      }
      throw error;
    }

    res.json({ data, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
};

export const getMyRestaurant = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ data: null, error: 'Missing user id on token' });
    }

    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, location, square_location_id, doordash_store_id, pos_connected, delivery_connected')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ data: null, error: 'No restaurant for this user' });
    }

    res.json({ data, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
};

export const getRestaurant = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, location, square_location_id, doordash_store_id, pos_connected, delivery_connected')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ data: null, error: 'Not found' });

    res.json({ data, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
};

export const updateRestaurant = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

    const { name, location, doordash_store_id } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (location !== undefined) updates.location = location;
    if (doordash_store_id !== undefined) updates.doordash_store_id = doordash_store_id;

    const { data, error } = await supabase
      .from('restaurants')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, name, location, square_location_id, doordash_store_id, pos_connected, delivery_connected')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ data: null, error: 'Not found' });

    res.json({ data, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
};