import { Request, Response } from 'express';
import { supabase } from '../server';

interface AuthRequest extends Request {
  user?: any;
}

export const createRestaurant = async (req: AuthRequest, res: Response) => {
  try {
    const { name, location, pos_connected, delivery_connected, toast_guid, doordash_store_id } = req.body;
    const userId = req.user.sub; // Assuming Supabase user id

    const { data, error } = await supabase
      .from('restaurants')
      .insert({
        name,
        location,
        pos_connected: pos_connected || false,
        delivery_connected: delivery_connected || false,
        toast_guid,
        doordash_store_id,
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