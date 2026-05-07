import { Request, Response } from 'express';
import { supabase } from '../server';

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

    if (error) throw error;

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

    const { data, error } = await supabase
      .from('restaurants')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    res.json({ data, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
};

export const updateRestaurant = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('restaurants')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ data, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
};